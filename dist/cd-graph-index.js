import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
function resolveProjectRoot() {
    if (existsSync(path.join(process.cwd(), '.env'))) {
        return process.cwd();
    }
    return path.resolve(__dirname, '..');
}
const PROJECT_ROOT = resolveProjectRoot();
dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });
const QUERY_DIR = path.join(PROJECT_ROOT, 'query');
const TEMP_QUERY_FILE = path.join(QUERY_DIR, 'temp.graphql');
const OUT_DIR = path.join(PROJECT_ROOT, 'out');
const OUT_FILE = path.join(OUT_DIR, 'data.json');
const DATA_SAVE_PATH = process.env.DATA_SAVE_PATH || '';
const RAG_FILE = path.join(PROJECT_ROOT, 'rag', 'document.txt');
const SERVER_NAME = process.env.SERVER_NAME || 'optimizely-saas-mcp-server';
const SERVER_VERSION = process.env.SERVER_VERSION || '1.0.0';
const GRAPH_ENDPOINT = process.env.GRAPH_ENDPOINT || '';
const GRAPH_AUTH_METHOD = (process.env.GRAPH_AUTH_METHOD || 'single_key').toLowerCase();
const GRAPH_SINGLE_KEY = process.env.GRAPH_SINGLE_KEY || '';
const GRAPH_BEARER_TOKEN = process.env.GRAPH_BEARER_TOKEN || '';
const CACHE_TTL = Number(process.env.CACHE_TTL || 300000);
const TIMEOUT = Number(process.env.TIMEOUT || 30000);
const GRAPH_TYPE_REF_FRAGMENT = `
fragment TypeRef on __Type {
	kind
	name
	ofType {
		kind
		name
		ofType {
			kind
			name
			ofType {
				kind
				name
				ofType {
					kind
					name
					ofType {
						kind
						name
					}
				}
			}
		}
	}
}`;
const ROOT_FIELDS_QUERY = `
query RootFields {
	__schema {
		queryType {
			name
			fields {
				name
				description
				args {
					name
					description
					type {
						...TypeRef
					}
				}
				type {
					...TypeRef
				}
			}
		}
	}
}
${GRAPH_TYPE_REF_FRAGMENT}`;
const TYPE_DETAILS_QUERY = `
query TypeDetails($name: String!) {
	__type(name: $name) {
		name
		kind
		fields {
			name
			description
			args {
				name
				description
				type {
					...TypeRef
				}
			}
			type {
				...TypeRef
			}
		}
	}
}
${GRAPH_TYPE_REF_FRAGMENT}`;
const cache = new Map();
function logError(message, details) {
    const suffix = details ? ` ${JSON.stringify(details, null, 2)}` : '';
    process.stderr.write(`[${SERVER_NAME}] ${message}${suffix}\n`);
}
async function ensureDirectories() {
    await mkdir(QUERY_DIR, { recursive: true });
    await mkdir(OUT_DIR, { recursive: true });
}
function ensureGraphConfig() {
    if (!GRAPH_ENDPOINT) {
        throw new Error('GRAPH_ENDPOINT is required in .env');
    }
    if (GRAPH_AUTH_METHOD === 'single_key' && !GRAPH_SINGLE_KEY) {
        throw new Error('GRAPH_SINGLE_KEY is required when GRAPH_AUTH_METHOD=single_key');
    }
    if (GRAPH_AUTH_METHOD === 'bearer' && !GRAPH_BEARER_TOKEN) {
        throw new Error('GRAPH_BEARER_TOKEN is required when GRAPH_AUTH_METHOD=bearer');
    }
}
function buildGraphUrl() {
    const url = new URL(GRAPH_ENDPOINT);
    if (GRAPH_AUTH_METHOD === 'single_key' && GRAPH_SINGLE_KEY && !url.searchParams.has('auth')) {
        url.searchParams.set('auth', GRAPH_SINGLE_KEY);
    }
    return url.toString();
}
function buildHeaders() {
    const headers = {
        'content-type': 'application/json',
    };
    if (GRAPH_AUTH_METHOD === 'bearer' && GRAPH_BEARER_TOKEN) {
        headers.authorization = `Bearer ${GRAPH_BEARER_TOKEN}`;
    }
    return headers;
}
function createTimeoutSignal(timeoutMs) {
    return AbortSignal.timeout(timeoutMs);
}
async function executeGraphQuery(query, variables) {
    ensureGraphConfig();
    const response = await fetch(buildGraphUrl(), {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({ query, variables }),
        signal: createTimeoutSignal(TIMEOUT),
    });
    const bodyText = await response.text();
    let parsedBody;
    try {
        parsedBody = bodyText ? JSON.parse(bodyText) : {};
    }
    catch (error) {
        throw new Error(`Graph response was not valid JSON: ${error.message}`);
    }
    if (!response.ok) {
        throw new Error(`Graph request failed with status ${response.status}: ${bodyText}`);
    }
    return parsedBody;
}
async function getCachedValue(key, factory) {
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.value;
    }
    const freshValue = await factory();
    cache.set(key, {
        expiresAt: Date.now() + CACHE_TTL,
        value: freshValue,
    });
    return freshValue;
}
function unwrapType(type) {
    let current = type ?? null;
    while (current?.ofType) {
        current = current.ofType;
    }
    return current;
}
function typeToString(type) {
    if (!type) {
        return 'Unknown';
    }
    if (type.ofType) {
        return `${type.kind}(${typeToString(type.ofType)})`;
    }
    return type.name || type.kind;
}
async function getRootQueryFields() {
    return getCachedValue('root-fields', async () => {
        const result = await executeGraphQuery(ROOT_FIELDS_QUERY);
        if (result.errors) {
            throw new Error(`Graph introspection failed: ${JSON.stringify(result.errors)}`);
        }
        return result.data?.__schema?.queryType?.fields || [];
    });
}
async function getTypeDetails(typeName) {
    return getCachedValue(`type:${typeName}`, async () => {
        const result = await executeGraphQuery(TYPE_DETAILS_QUERY, { name: typeName });
        if (result.errors) {
            throw new Error(`Type introspection failed for ${typeName}: ${JSON.stringify(result.errors)}`);
        }
        const type = result.data?.__type;
        if (!type) {
            throw new Error(`Type ${typeName} was not found in the Graph schema.`);
        }
        return type;
    });
}
async function listContentTypes(search) {
    const rootFields = await getRootQueryFields();
    const filtered = rootFields.filter((field) => /^[A-Z]/.test(field.name) && !field.name.startsWith('__'));
    if (!search) {
        return filtered.sort((left, right) => left.name.localeCompare(right.name));
    }
    const lowered = search.toLowerCase();
    return filtered
        .filter((field) => field.name.toLowerCase().includes(lowered))
        .sort((left, right) => left.name.localeCompare(right.name));
}
async function describeContentType(typeName) {
    const rootFields = await getRootQueryFields();
    const rootField = rootFields.find((field) => field.name === typeName);
    if (!rootField) {
        throw new Error(`Content type ${typeName} was not found in the root Graph schema.`);
    }
    const resultTypeName = unwrapType(rootField.type)?.name;
    if (!resultTypeName) {
        throw new Error(`Unable to resolve the result type for ${typeName}.`);
    }
    const resultType = await getTypeDetails(resultTypeName);
    const itemsField = resultType.fields?.find((field) => field.name === 'items');
    if (!itemsField) {
        throw new Error(`Result type ${resultTypeName} for ${typeName} does not expose an items field.`);
    }
    const itemTypeName = unwrapType(itemsField.type)?.name;
    if (!itemTypeName) {
        throw new Error(`Unable to resolve the item type for ${typeName}.`);
    }
    const itemType = await getTypeDetails(itemTypeName);
    return {
        rootFieldName: rootField.name,
        rootArguments: rootField.args || [],
        resultTypeName,
        itemTypeName,
        itemFields: itemType.fields || [],
    };
}
async function saveGeneratedQuery(query) {
    await ensureDirectories();
    await writeFile(TEMP_QUERY_FILE, `${query.trim()}\n`, 'utf8');
    return TEMP_QUERY_FILE;
}
function resolveDataSavePath(overridePath) {
    const selectedPath = typeof overridePath === 'string' && overridePath.trim()
        ? overridePath.trim()
        : DATA_SAVE_PATH.trim() || OUT_FILE;
    const absolutePath = path.isAbsolute(selectedPath)
        ? selectedPath
        : path.resolve(PROJECT_ROOT, selectedPath);
    if (absolutePath.endsWith('/') || absolutePath.endsWith('\\')) {
        return path.join(absolutePath, 'data.json');
    }
    if (existsSync(absolutePath)) {
        const stats = statSync(absolutePath);
        if (stats.isDirectory()) {
            return path.join(absolutePath, 'data.json');
        }
    }
    return absolutePath;
}
async function saveResponse(payload, overridePath) {
    const outputPath = resolveDataSavePath(overridePath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return outputPath;
}
function isScalarOrEnumField(field) {
    const namedType = unwrapType(field.type);
    return namedType?.kind === 'SCALAR' || namedType?.kind === 'ENUM';
}
function normalizeTokens(input) {
    return input
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .map((value) => value.trim())
        .filter(Boolean);
}
function scoreTypeName(typeName, request) {
    const loweredRequest = request.toLowerCase();
    const collapsedType = typeName.toLowerCase();
    const typeWords = collapsedType.split(/(?=[A-Z])/).map((value) => value.toLowerCase());
    let score = 0;
    if (loweredRequest.includes(collapsedType)) {
        score += 10;
    }
    for (const word of typeWords) {
        if (word && loweredRequest.includes(word)) {
            score += 3;
        }
    }
    if (loweredRequest.includes(collapsedType.replace(/s$/, ''))) {
        score += 2;
    }
    return score;
}
async function inferContentTypeName(request) {
    const types = await listContentTypes();
    const scored = types
        .map((field) => ({
        name: field.name,
        score: scoreTypeName(field.name, request),
    }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
    return scored[0]?.name;
}
function pickFields(request, fields) {
    const scalarFields = fields.filter(isScalarOrEnumField);
    const tokens = normalizeTokens(request);
    const preferredPatterns = [/^_id$/i, /^title$/i, /^name$/i, /^display/i, /^url$/i, /^slug$/i, /^mime/i, /^media/i, /^type/i, /^publish/i, /^modified/i];
    const scored = scalarFields.map((field) => {
        const lowered = field.name.toLowerCase();
        let score = preferredPatterns.some((pattern) => pattern.test(field.name)) ? 3 : 0;
        for (const token of tokens) {
            if (lowered === token) {
                score += 10;
            }
            else if (lowered.includes(token) || token.includes(lowered)) {
                score += 4;
            }
        }
        return { field: field.name, score };
    });
    const selected = scored
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || left.field.localeCompare(right.field))
        .map((entry) => entry.field);
    const fallback = scalarFields
        .map((field) => field.name)
        .sort((left, right) => left.localeCompare(right));
    const finalFields = [...new Set([...selected, ...fallback])].slice(0, 8);
    return finalFields.length > 0 ? finalFields : ['_id'];
}
function parseLimit(request, explicitLimit) {
    if (explicitLimit && explicitLimit > 0) {
        return explicitLimit;
    }
    const match = request.match(/(?:top|first|limit)\s+(\d{1,3})/i);
    if (!match) {
        return 10;
    }
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}
function extractLocale(request) {
    const localeMatch = request.match(/\b([a-z]{2}(?:-[A-Z]{2})?)\b/);
    return localeMatch?.[1];
}
function buildArgumentString(args) {
    return args.length > 0 ? `(${args.join(', ')})` : '';
}
function escapeGraphString(input) {
    return input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
function buildListContentTypesQuery() {
    return {
        mode: 'content-type-list',
        request: 'List content types',
        query: ROOT_FIELDS_QUERY,
        summary: 'List available Optimizely Graph content types via schema introspection.',
    };
}
function buildContentTypeDetailsQuery(typeName, request) {
    return {
        mode: 'content-type-detail',
        request,
        query: TYPE_DETAILS_QUERY,
        variables: { name: typeName },
        inferredTypeName: typeName,
        summary: `Describe content type ${typeName} via schema introspection.`,
    };
}
async function buildContentItemsQuery(request, typeName, explicitLimit) {
    const description = await describeContentType(typeName);
    const limit = parseLimit(request, explicitLimit);
    const locale = extractLocale(request);
    const args = [];
    const rootArgNames = new Set(description.rootArguments.map((arg) => arg.name));
    if (rootArgNames.has('limit')) {
        args.push(`limit: ${limit}`);
    }
    if (locale && rootArgNames.has('locale')) {
        args.push(`locale: "${escapeGraphString(locale)}"`);
    }
    const selectedFields = pickFields(request, description.itemFields);
    const query = `query ${description.rootFieldName}Generated {\n  ${description.rootFieldName}${buildArgumentString(args)} {\n    total\n    items {\n      ${selectedFields.join('\n      ')}\n    }\n  }\n}`;
    return {
        mode: 'content-list',
        request,
        query,
        inferredTypeName: description.rootFieldName,
        selectedFields,
        summary: `Fetch ${description.rootFieldName} items from Optimizely Graph.`,
    };
}
async function buildExecutionFromNaturalLanguage(request, explicitLimit) {
    const lowered = request.toLowerCase();
    const inferredTypeName = await inferContentTypeName(request);
    if (/(content\s*types?|list\s+types|schema)/i.test(lowered) && !inferredTypeName) {
        return buildListContentTypesQuery();
    }
    if (/(content\s*type|schema|fields?|properties)/i.test(lowered) && inferredTypeName) {
        return buildContentTypeDetailsQuery(inferredTypeName, request);
    }
    if (inferredTypeName) {
        return buildContentItemsQuery(request, inferredTypeName, explicitLimit);
    }
    return buildListContentTypesQuery();
}
async function readReferenceLinks() {
    if (!existsSync(RAG_FILE)) {
        return 'No local Graph reference file was found in rag/document.txt.';
    }
    return readFile(RAG_FILE, 'utf8');
}
function shorten(text, maxLength) {
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
function asObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }
    return value;
}
async function runAndPersistQuery(params) {
    const queryPath = params.saveQueryFile === false ? undefined : await saveGeneratedQuery(params.query);
    const response = await executeGraphQuery(params.query, params.variables);
    const responsePath = await saveResponse({
        savedAt: new Date().toISOString(),
        request: params.requestLabel,
        query: params.query,
        variables: params.variables || null,
        queryFile: queryPath || null,
        metadata: params.metadata || {},
        response,
    }, params.outputPath);
    return {
        responsePath,
        queryPath,
        response,
    };
}
function formatPathForUser(filePath) {
    return path.relative(PROJECT_ROOT, filePath).replace(/\\/g, '/');
}
async function handleListContentTypes(args) {
    const search = typeof args.search === 'string' ? args.search : undefined;
    const outputPath = typeof args.outputPath === 'string' ? args.outputPath : undefined;
    const types = await listContentTypes(search);
    const payload = {
        count: types.length,
        items: types.map((type) => ({
            name: type.name,
            description: type.description || null,
            arguments: (type.args || []).map((arg) => ({
                name: arg.name,
                type: typeToString(arg.type),
            })),
        })),
    };
    const responsePath = await saveResponse({
        savedAt: new Date().toISOString(),
        request: 'list content types',
        response: payload,
    }, outputPath);
    return JSON.stringify({
        message: `Found ${types.length} content types. Response saved to ${formatPathForUser(responsePath)}.`,
        ...payload,
    }, null, 2);
}
async function handleDescribeContentType(args) {
    const typeName = typeof args.typeName === 'string' ? args.typeName.trim() : '';
    const outputPath = typeof args.outputPath === 'string' ? args.outputPath : undefined;
    if (!typeName) {
        throw new Error('typeName is required.');
    }
    const description = await describeContentType(typeName);
    // Filter out system-defined fields (those starting with underscore)
    const customFields = description.itemFields
        .filter((field) => !field.name.startsWith('_'))
        .map((field) => field.name);
    const payload = {
        name: description.rootFieldName,
        guid: description.rootFieldName,
        fields: customFields,
    };
    await saveResponse(payload, outputPath);
    return JSON.stringify(payload, null, 2);
}
async function handleExecuteQuery(args) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const outputPath = typeof args.outputPath === 'string' ? args.outputPath : undefined;
    if (!query) {
        throw new Error('query is required.');
    }
    let variables;
    if (typeof args.variablesJson === 'string' && args.variablesJson.trim()) {
        variables = JSON.parse(args.variablesJson);
    }
    else if (args.variables && typeof args.variables === 'object' && !Array.isArray(args.variables)) {
        variables = args.variables;
    }
    const saveQuery = args.saveQuery !== false;
    const executed = await runAndPersistQuery({
        requestLabel: 'execute raw graph query',
        query,
        variables,
        saveQueryFile: saveQuery,
        outputPath,
        metadata: {
            source: 'graph_execute_query',
        },
    });
    return JSON.stringify({
        message: `Graph query executed. Response saved to ${formatPathForUser(executed.responsePath)}.`,
        responsePreview: shorten(JSON.stringify(executed.response, null, 2), 4000),
    }, null, 2);
}
async function handleNaturalLanguageQuery(args) {
    const request = typeof args.request === 'string' ? args.request.trim() : '';
    if (!request) {
        throw new Error('request is required.');
    }
    const limit = typeof args.limit === 'number' ? args.limit : undefined;
    const saveQuery = args.saveQuery !== false;
    const outputPath = typeof args.outputPath === 'string' ? args.outputPath : undefined;
    const execution = await buildExecutionFromNaturalLanguage(request, limit);
    const executed = await runAndPersistQuery({
        requestLabel: request,
        query: execution.query,
        variables: execution.variables,
        saveQueryFile: saveQuery,
        outputPath,
        metadata: {
            mode: execution.mode,
            inferredTypeName: execution.inferredTypeName || null,
            selectedFields: execution.selectedFields || [],
            summary: execution.summary,
        },
    });
    return JSON.stringify({
        message: `Natural-language Graph request executed. Response saved to ${formatPathForUser(executed.responsePath)}.`,
        mode: execution.mode,
        inferredTypeName: execution.inferredTypeName || null,
        selectedFields: execution.selectedFields || [],
        generatedQuery: execution.query,
        responsePreview: shorten(JSON.stringify(executed.response, null, 2), 4000),
    }, null, 2);
}
async function handleReferenceLinks() {
    const references = await readReferenceLinks();
    return JSON.stringify({
        message: 'Loaded Graph reference links from rag/document.txt.',
        references,
    }, null, 2);
}
function getToolDefinitions() {
    return [
        {
            name: 'graph_nl_query',
            description: 'Parse a natural-language request into an Optimizely Graph query or introspection query, execute it, optionally overwrite query/temp.graphql with the generated query, and save the response to DATA_SAVE_PATH (or out/data.json by default).',
            inputSchema: {
                type: 'object',
                properties: {
                    request: {
                        type: 'string',
                        description: 'Natural-language request, for example: list content types, describe BlogPost fields, or get top 5 media items.',
                    },
                    limit: {
                        type: 'number',
                        description: 'Optional result limit when the request is a content fetch.',
                    },
                    saveQuery: {
                        type: 'boolean',
                        description: 'When true, save the generated Graph query into the query folder.',
                    },
                    outputPath: {
                        type: 'string',
                        description: 'Optional file path to save the response JSON for this call. If omitted, DATA_SAVE_PATH is used.',
                    },
                },
                required: ['request'],
                additionalProperties: false,
            },
        },
        {
            name: 'graph_list_content_types',
            description: 'Read available Optimizely SaaS CMS content types from the Optimizely Graph schema using Graph introspection only.',
            inputSchema: {
                type: 'object',
                properties: {
                    search: {
                        type: 'string',
                        description: 'Optional text filter for content type names.',
                    },
                    outputPath: {
                        type: 'string',
                        description: 'Optional file path to save the response JSON for this call. If omitted, DATA_SAVE_PATH is used.',
                    },
                },
                additionalProperties: false,
            },
        },
        {
            name: 'graph_describe_content_type',
            description: 'Describe a specific Optimizely Graph content type, including root arguments and available item fields.',
            inputSchema: {
                type: 'object',
                properties: {
                    typeName: {
                        type: 'string',
                        description: 'Exact content type/root field name from the Graph schema.',
                    },
                    outputPath: {
                        type: 'string',
                        description: 'Optional file path to save the response JSON for this call. If omitted, DATA_SAVE_PATH is used.',
                    },
                },
                required: ['typeName'],
                additionalProperties: false,
            },
        },
        {
            name: 'graph_execute_query',
            description: 'Execute a raw Optimizely Graph query directly, optionally overwrite query/temp.graphql with the query, and always persist the response to DATA_SAVE_PATH (or out/data.json by default).',
            inputSchema: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Raw GraphQL query string to execute against Optimizely Graph.',
                    },
                    variablesJson: {
                        type: 'string',
                        description: 'Optional JSON string of GraphQL variables.',
                    },
                    saveQuery: {
                        type: 'boolean',
                        description: 'When true, save the raw query into the query folder.',
                    },
                    queryName: {
                        type: 'string',
                        description: 'Deprecated. Query is always saved to query/temp.graphql when saveQuery=true.',
                    },
                    outputPath: {
                        type: 'string',
                        description: 'Optional file path to save the response JSON for this call. If omitted, DATA_SAVE_PATH is used.',
                    },
                },
                required: ['query'],
                additionalProperties: false,
            },
        },
        {
            name: 'graph_reference_links',
            description: 'Read the local Graph reference links from rag/document.txt when documentation context is needed.',
            inputSchema: {
                type: 'object',
                properties: {},
                additionalProperties: false,
            },
        },
    ];
}
async function startMcpServer() {
    await ensureDirectories();
    ensureGraphConfig();
    const server = new Server({
        name: SERVER_NAME,
        version: SERVER_VERSION,
    }, {
        capabilities: {
            tools: {},
        },
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: getToolDefinitions(),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const args = asObject(request.params.arguments);
        try {
            switch (request.params.name) {
                case 'graph_nl_query':
                    return { content: [{ type: 'text', text: await handleNaturalLanguageQuery(args) }] };
                case 'graph_list_content_types':
                    return { content: [{ type: 'text', text: await handleListContentTypes(args) }] };
                case 'graph_describe_content_type':
                    return { content: [{ type: 'text', text: await handleDescribeContentType(args) }] };
                case 'graph_execute_query':
                    return { content: [{ type: 'text', text: await handleExecuteQuery(args) }] };
                case 'graph_reference_links':
                    return { content: [{ type: 'text', text: await handleReferenceLinks() }] };
                default:
                    throw new Error(`Unknown tool: ${request.params.name}`);
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logError(`Tool ${request.params.name} failed`, { message });
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            error: message,
                        }, null, 2),
                    },
                ],
                isError: true,
            };
        }
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
async function runSelfTest() {
    await ensureDirectories();
    const types = await listContentTypes();
    const result = {
        status: 'ok',
        graphEndpoint: buildGraphUrl(),
        contentTypeCount: types.length,
        sampleTypes: types.slice(0, 10).map((type) => type.name),
    };
    await saveResponse({
        savedAt: new Date().toISOString(),
        request: 'self-test',
        response: result,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
async function runNaturalLanguageFromCli(request) {
    const output = await handleNaturalLanguageQuery({ request, saveQuery: true });
    process.stdout.write(`${output}\n`);
}
async function main() {
    const [, , command, ...rest] = process.argv;
    if (command === '--self-test') {
        await runSelfTest();
        return;
    }
    if (command === '--run-nl') {
        const request = rest.join(' ').trim();
        if (!request) {
            throw new Error('Provide a natural-language request after --run-nl.');
        }
        await runNaturalLanguageFromCli(request);
        return;
    }
    await startMcpServer();
}
main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    logError('Server failed to start', { message });
    process.exit(1);
});
