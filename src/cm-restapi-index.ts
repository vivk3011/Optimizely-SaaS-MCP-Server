import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

type JsonObject = Record<string, unknown>;

type TokenResponse = {
	access_token: string;
	token_type: string;
	expires_in: number;
	timestamp: number;
};

type SavedTokenData = TokenResponse & {
	timestamp: number;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveProjectRoot(): string {
	if (existsSync(path.join(process.cwd(), '.env'))) {
		return process.cwd();
	}
	return path.resolve(__dirname, '..');
}

const PROJECT_ROOT = resolveProjectRoot();

dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

const QUERY_DIR = path.join(PROJECT_ROOT, 'query');
const TEMP_REST_FILE = path.join(QUERY_DIR, 'temp.rest.txt');
const OUT_DIR = path.join(PROJECT_ROOT, 'out');
const OUT_FILE = path.join(OUT_DIR, 'data.json');
const DATA_SAVE_PATH = process.env.DATA_SAVE_PATH || '';
const AUTH_DIR = path.join(PROJECT_ROOT, 'auth');
const TOKEN_FILE = path.join(AUTH_DIR, 'token.txt');

const CMA_BASE_URL = process.env.CMA_BASE_URL || 'https://api.cms.optimizely.com/v1';
const CMA_CLIENT_ID = process.env.CMA_CLIENT_ID || '';
const CMA_CLIENT_SECRET = process.env.CMA_CLIENT_SECRET || '';
const CMA_GRANT_TYPE = process.env.CMA_GRANT_TYPE || 'client_credentials';
const CMA_TOKEN_ENDPOINT = process.env.CMA_TOKEN_ENDPOINT || 'https://api.cms.optimizely.com/oauth/token';

const SERVER_NAME = process.env.SERVER_NAME || 'optimizely-cma-mcp-server';
const SERVER_VERSION = process.env.SERVER_VERSION || '1.0.0';
const TIMEOUT = Number(process.env.TIMEOUT || 30000);

// Ensure directories exist
async function ensureDirectories(): Promise<void> {
	for (const dir of [QUERY_DIR, OUT_DIR, AUTH_DIR]) {
		if (!existsSync(dir)) {
			await mkdir(dir, { recursive: true });
		}
	}
}

// ============================================================================
// AUTH TOKEN MANAGEMENT
// ============================================================================

async function isTokenValid(token: SavedTokenData): Promise<boolean> {
	const now = Date.now();
	const expiresAt = token.timestamp + token.expires_in * 1000;
	// Consider token valid if it expires in more than 60 seconds
	return now < expiresAt - 60000;
}

async function getSavedToken(): Promise<SavedTokenData | null> {
	try {
		if (existsSync(TOKEN_FILE)) {
			const content = await readFile(TOKEN_FILE, 'utf-8');
			const token: SavedTokenData = JSON.parse(content);
			if (await isTokenValid(token)) {
				return token;
			}
		}
	} catch {
		// Token file invalid or expired
	}
	return null;
}

async function generateAndSaveToken(): Promise<string> {
	const authHeader = Buffer.from(`${CMA_CLIENT_ID}:${CMA_CLIENT_SECRET}`).toString('base64');

	const response = await fetch(CMA_TOKEN_ENDPOINT, {
		method: 'POST',
		headers: {
			'Authorization': `Basic ${authHeader}`,
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({
			grant_type: CMA_GRANT_TYPE,
		}).toString(),
	});

	if (!response.ok) {
		throw new Error(`Failed to get token: ${response.statusText}`);
	}

	const tokenData: TokenResponse = await response.json();
	const tokenWithTimestamp: SavedTokenData = {
		...tokenData,
		timestamp: Date.now(),
	};

	await writeFile(TOKEN_FILE, JSON.stringify(tokenWithTimestamp, null, 2));
	return tokenData.access_token;
}

async function getValidToken(): Promise<string> {
	const savedToken = await getSavedToken();
	if (savedToken) {
		return savedToken.access_token;
	}
	return await generateAndSaveToken();
}

// ============================================================================
// REST API REQUEST BUILDER
// ============================================================================

async function makeRestRequest(
	method: string,
	endpoint: string,
	body?: JsonObject,
	options?: { headers?: Record<string, string>; contentType?: string }
): Promise<JsonObject> {
	const token = await getValidToken();
	const url = CMA_BASE_URL + endpoint;

	const headers: Record<string, string> = {
		'Authorization': `Bearer ${token}`,
		'Content-Type': options?.contentType || 'application/json',
		...options?.headers,
	};

	// Save request details to temp.rest.txt
	const restDetails = `${method} ${url}
Headers:
${JSON.stringify(headers, null, 2)}
${body ? `Body:\n${JSON.stringify(body, null, 2)}` : ''}`;

	await writeFile(TEMP_REST_FILE, restDetails);

	const fetchOptions: RequestInit = {
		method,
		headers,
	};

	if (body) {
		fetchOptions.body = JSON.stringify(body);
	}

	const response = await fetch(url, fetchOptions);

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`API Error (${response.status}): ${errorText}`);
	}

	return await response.json() as JsonObject;
}

async function saveFilteredResponse(data: unknown): Promise<void> {
	const outputPath = resolveDataSavePath();
	await mkdir(path.dirname(outputPath), { recursive: true });
	await writeFile(outputPath, JSON.stringify(data, null, 2));
}

function resolveDataSavePath(): string {
	const configuredPath = DATA_SAVE_PATH.trim();
	const selectedPath = configuredPath || OUT_FILE;
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

type ContentTypeFieldInput = {
	name: string;
	type: string;
	displayName?: string;
	description?: string;
	format?: string;
	required?: boolean;
	localized?: boolean;
	group?: string;
	sortOrder?: number;
	allowedTypes?: string[];
	restrictedTypes?: string[];
	mediaOnly?: boolean;
	onlyMedia?: boolean;
	allowOnlyMedia?: boolean;
};

function toDisplayName(value: string): string {
	return value
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/[\s_-]+/g, ' ')
		.trim()
		.split(' ')
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}

function normalizePropertyType(rawType: string): string {
	const normalized = rawType.trim().toLowerCase().replace(/[\s_-]+/g, '');

	switch (normalized) {
		case 'string':
		case 'shortstring':
			return 'string';
		case 'richtext':
		case 'ricktext':
		case 'longtext':
			return 'richText';
		case 'url':
		case 'link':
		case 'hyperlink':
			return 'url';
		case 'contentreference':
		case 'contentref':
		case 'reference':
		case 'contenturi':
			return 'contentReference';
		default:
			return rawType;
	}
}

function normalizePropertyDefinition(rawDefinition: unknown): JsonObject {
	if (!rawDefinition || typeof rawDefinition !== 'object' || Array.isArray(rawDefinition)) {
		return {};
	}

	const definition = { ...(rawDefinition as JsonObject) };

	if (typeof definition.type === 'string') {
		definition.type = normalizePropertyType(definition.type);
	}

	if ('required' in definition && typeof definition.required === 'boolean') {
		definition.isRequired = definition.required;
	}
	if ('localized' in definition && typeof definition.localized === 'boolean') {
		definition.isLocalized = definition.localized;
	}

	const mediaOnly =
		definition.mediaOnly === true ||
		definition.onlyMedia === true ||
		definition.allowOnlyMedia === true;

	if (
		definition.type === 'contentReference' &&
		mediaOnly &&
		(!Array.isArray(definition.allowedTypes) || definition.allowedTypes.length === 0)
	) {
		definition.allowedTypes = ['_media'];
	}

	delete definition.required;
	delete definition.localized;
	delete definition.mediaOnly;
	delete definition.onlyMedia;
	delete definition.allowOnlyMedia;

	return definition;
}

function buildPropertiesFromFields(fields?: ContentTypeFieldInput[]): JsonObject | undefined {
	if (!fields || fields.length === 0) {
		return undefined;
	}

	const properties: JsonObject = {};

	for (const field of fields) {
		if (!field.name || !field.type) {
			continue;
		}

		const normalizedType = normalizePropertyType(field.type);
		const definition: JsonObject = {
			type: normalizedType,
			displayName: field.displayName || toDisplayName(field.name),
		};

		if (field.description) definition.description = field.description;
		if (field.format) definition.format = field.format;
		if (typeof field.required === 'boolean') definition.isRequired = field.required;
		if (typeof field.localized === 'boolean') definition.isLocalized = field.localized;
		if (field.group) definition.group = field.group;
		if (typeof field.sortOrder === 'number') definition.sortOrder = field.sortOrder;
		if (field.allowedTypes?.length) definition.allowedTypes = field.allowedTypes;
		if (field.restrictedTypes?.length) definition.restrictedTypes = field.restrictedTypes;

		const mediaOnly = field.mediaOnly || field.onlyMedia || field.allowOnlyMedia;
		if (
			normalizedType === 'contentReference' &&
			mediaOnly &&
			(!Array.isArray(definition.allowedTypes) || definition.allowedTypes.length === 0)
		) {
			definition.allowedTypes = ['_media'];
		}

		properties[field.name] = definition;
	}

	return Object.keys(properties).length > 0 ? properties : undefined;
}

function normalizeProperties(properties?: JsonObject): JsonObject | undefined {
	if (!properties) {
		return undefined;
	}

	const normalized: JsonObject = {};
	for (const [fieldName, definition] of Object.entries(properties)) {
		normalized[fieldName] = normalizePropertyDefinition(definition);
	}

	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function mergeContentTypeProperties(input: {
	properties?: JsonObject;
	fields?: ContentTypeFieldInput[];
}): JsonObject | undefined {
	const normalizedFromProperties = normalizeProperties(input.properties) || {};
	const fromFields = buildPropertiesFromFields(input.fields) || {};
	const merged = {
		...normalizedFromProperties,
		...fromFields,
	};

	return Object.keys(merged).length > 0 ? merged : undefined;
}

// ============================================================================
// CONTENT TYPES MANAGEMENT
// ============================================================================

async function create_content_type(input: {
	key: string;
	baseType: string;
	displayName: string;
	properties?: JsonObject;
	fields?: ContentTypeFieldInput[];
	description?: string;
}): Promise<JsonObject> {
	const payload: JsonObject = {
		key: input.key,
		baseType: input.baseType,
		displayName: input.displayName,
	};

	if (input.description) payload.description = input.description;
	const mergedProperties = mergeContentTypeProperties({
		properties: input.properties,
		fields: input.fields,
	});
	if (mergedProperties) payload.properties = mergedProperties;

	const result = await makeRestRequest('POST', '/contenttypes', payload);
	await saveFilteredResponse(result);
	return result;
}

async function get_content_type(input: { key: string }): Promise<JsonObject> {
	const result = await makeRestRequest('GET', `/contenttypes/${input.key}`);
	await saveFilteredResponse(result);
	return result;
}

async function list_content_types(input: { search?: string; limit?: number } = {}): Promise<JsonObject> {
	let endpoint = '/contenttypes';
	const params = new URLSearchParams();

	if (input.limit) params.append('pageSize', input.limit.toString());

	if (params.toString()) {
		endpoint += `?${params.toString()}`;
	}

	const result = await makeRestRequest('GET', endpoint);

	// Filter if search provided
	if (input.search && typeof result === 'object' && result !== null && 'items' in result) {
		const items = (result.items as Array<any>) || [];
		const filtered = items.filter(ct =>
			(ct.key?.toLowerCase().includes(input.search!.toLowerCase()) ||
				ct.displayName?.toLowerCase().includes(input.search!.toLowerCase()))
		);
		const response = { ...result, items: filtered };
		await saveFilteredResponse(response);
		return response;
	}

	await saveFilteredResponse(result);
	return result;
}

async function update_content_type(input: {
	key: string;
	displayName?: string;
	description?: string;
	properties?: JsonObject;
	fields?: ContentTypeFieldInput[];
	ignoreDataLossWarnings?: boolean;
}): Promise<JsonObject> {
	const payload: JsonObject = {};

	if (input.displayName) payload.displayName = input.displayName;
	if (input.description) payload.description = input.description;
	const mergedProperties = mergeContentTypeProperties({
		properties: input.properties,
		fields: input.fields,
	});
	if (mergedProperties) payload.properties = mergedProperties;

	const endpoint = input.ignoreDataLossWarnings
		? `/contenttypes/${input.key}?ignoreDataLossWarnings=true`
		: `/contenttypes/${input.key}`;

	const result = await makeRestRequest(
		'PATCH',
		endpoint,
		payload,
		{ headers: { 'Content-Type': 'application/merge-patch+json' } }
	);
	await saveFilteredResponse(result);
	return result;
}

async function upsert_content_type(input: {
	key: string;
	baseType?: string;
	displayName?: string;
	description?: string;
	properties?: JsonObject;
	fields?: ContentTypeFieldInput[];
	ignoreDataLossWarnings?: boolean;
}): Promise<JsonObject> {
	try {
		await get_content_type({ key: input.key });
		return await update_content_type({
			key: input.key,
			displayName: input.displayName,
			description: input.description,
			properties: input.properties,
			fields: input.fields,
			ignoreDataLossWarnings: input.ignoreDataLossWarnings,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!message.includes('API Error (404)')) {
			throw error;
		}

		return await create_content_type({
			key: input.key,
			baseType: input.baseType || '_component',
			displayName: input.displayName || toDisplayName(input.key),
			description: input.description,
			properties: input.properties,
			fields: input.fields,
		});
	}
}

async function delete_content_type(input: { key: string }): Promise<JsonObject> {
	const result = await makeRestRequest('DELETE', `/contenttypes/${input.key}`);
	await saveFilteredResponse(result);
	return result;
}

// ============================================================================
// CONTENT MANAGEMENT
// ============================================================================

async function create_content(input: {
	key: string;
	contentType: string;
	container: string;
	displayName: string;
	locale?: string;
	properties?: JsonObject;
}): Promise<JsonObject> {
	const payload: JsonObject = {
		key: input.key,
		contentType: input.contentType,
		container: input.container,
		initialVersion: {
			displayName: input.displayName,
			locale: input.locale || 'en',
			properties: input.properties || {},
		},
	};

	const result = await makeRestRequest('POST', '/content', payload);
	await saveFilteredResponse(result);
	return result;
}

async function get_content(input: { key: string }): Promise<JsonObject> {
	const result = await makeRestRequest('GET', `/content/${input.key}`);
	await saveFilteredResponse(result);
	return result;
}

async function list_content_items(input: {
	parentKey: string;
	contentTypes?: string[];
	limit?: number;
}): Promise<JsonObject> {
	let endpoint = `/content/${input.parentKey}/items`;
	const params = new URLSearchParams();

	if (input.contentTypes && input.contentTypes.length > 0) {
		params.append('contentTypes', input.contentTypes.join(','));
	}
	if (input.limit) params.append('pageSize', input.limit.toString());

	if (params.toString()) {
		endpoint += `?${params.toString()}`;
	}

	const result = await makeRestRequest('GET', endpoint);
	await saveFilteredResponse(result);
	return result;
}

async function get_content_versions(input: {
	contentKey: string;
	locales?: string[];
	statuses?: string[];
}): Promise<JsonObject> {
	let endpoint = `/content/${input.contentKey}/versions`;
	const params = new URLSearchParams();

	if (input.locales && input.locales.length > 0) {
		params.append('locales', input.locales.join(','));
	}
	if (input.statuses && input.statuses.length > 0) {
		params.append('statuses', input.statuses.join(','));
	}

	if (params.toString()) {
		endpoint += `?${params.toString()}`;
	}

	const result = await makeRestRequest('GET', endpoint);
	await saveFilteredResponse(result);
	return result;
}

async function get_content_version(input: {
	contentKey: string;
	versionId: string;
}): Promise<JsonObject> {
	const result = await makeRestRequest('GET', `/content/${input.contentKey}/versions/${input.versionId}`);
	await saveFilteredResponse(result);
	return result;
}

async function create_content_version(input: {
	contentKey: string;
	displayName: string;
	locale: string;
	properties?: JsonObject;
}): Promise<JsonObject> {
	const payload: JsonObject = {
		displayName: input.displayName,
		locale: input.locale,
		properties: input.properties || {},
	};

	const result = await makeRestRequest('POST', `/content/${input.contentKey}/versions`, payload);
	await saveFilteredResponse(result);
	return result;
}

async function update_content_version(input: {
	contentKey: string;
	versionId: string;
	displayName?: string;
	properties?: JsonObject;
}): Promise<JsonObject> {
	const payload: JsonObject = {};

	if (input.displayName) payload.displayName = input.displayName;
	if (input.properties) payload.properties = input.properties;

	const result = await makeRestRequest(
		'PATCH',
		`/content/${input.contentKey}/versions/${input.versionId}`,
		payload,
		{ headers: { 'Content-Type': 'application/merge-patch+json' } }
	);
	await saveFilteredResponse(result);
	return result;
}

async function publish_content(input: {
	contentKey: string;
	versionId: string;
	delayUntil?: string;
	force?: boolean;
}): Promise<JsonObject> {
	const payload: JsonObject = {};
	if (input.delayUntil) payload.delayUntil = input.delayUntil;
	if (input.force) payload.force = input.force;

	const result = await makeRestRequest(
		'POST',
		`/content/${input.contentKey}/versions/${input.versionId}:publish`,
		payload
	);
	await saveFilteredResponse(result);
	return result;
}

async function ready_content(input: {
	contentKey: string;
	versionId: string;
	comment?: string;
}): Promise<JsonObject> {
	const payload: JsonObject = {};
	if (input.comment) payload.comment = input.comment;

	const result = await makeRestRequest(
		'POST',
		`/content/${input.contentKey}/versions/${input.versionId}:ready`,
		payload
	);
	await saveFilteredResponse(result);
	return result;
}

async function draft_content(input: {
	contentKey: string;
	versionId: string;
}): Promise<JsonObject> {
	const result = await makeRestRequest(
		'POST',
		`/content/${input.contentKey}/versions/${input.versionId}:draft`
	);
	await saveFilteredResponse(result);
	return result;
}

async function delete_content(input: {
	contentKey: string;
	permanent?: boolean;
}): Promise<JsonObject> {
	const options: { headers?: Record<string, string> } = {};
	if (input.permanent) {
		options.headers = { 'cms-permanent-delete': 'true' };
	}
	const result = await makeRestRequest('DELETE', `/content/${input.contentKey}`, undefined, options);
	await saveFilteredResponse(result);
	return result;
}

// ============================================================================
// MEDIA MANAGEMENT
// ============================================================================

async function create_media(input: {
	contentType: string;
	container: string;
	displayName: string;
	filePath: string;
	fileType?: string;
}): Promise<JsonObject> {
	const token = await getValidToken();
	const url = CMA_BASE_URL + '/content';

	// Read file
	const fileData = await readFile(input.filePath);
	const fileName = path.basename(input.filePath);

	// Create FormData
	const formData = new FormData();
	const contentPart = {
		contentType: input.contentType,
		container: input.container,
		initialVersion: {
			displayName: input.displayName,
		},
	};

	// Append as text with boundary
	formData.append(
		'content',
		new Blob([JSON.stringify(contentPart)], { type: 'application/json' }),
		'content.json'
	);

	// Append file
	formData.append(
		'file',
		new Blob([fileData], { type: input.fileType || 'application/octet-stream' }),
		fileName
	);

	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${token}`,
		},
		body: formData,
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Media upload failed (${response.status}): ${errorText}`);
	}

	const result = (await response.json()) as JsonObject;
	await saveFilteredResponse(result);
	return result;
}

async function get_media(input: {
	contentKey: string;
	versionId: string;
	outputPath?: string;
}): Promise<{ success: boolean; message: string }> {
	const token = await getValidToken();
	const url = CMA_BASE_URL + `/content/${input.contentKey}/versions/${input.versionId}/media`;

	const response = await fetch(url, {
		method: 'GET',
		headers: {
			'Authorization': `Bearer ${token}`,
		},
	});

	if (!response.ok) {
		throw new Error(`Failed to download media (${response.status})`);
	}

	const buffer = await response.arrayBuffer();
	const savePath = input.outputPath || path.join(OUT_DIR, 'media');
	await writeFile(savePath, Buffer.from(buffer));

	const result = { success: true, message: `Media saved to ${savePath}` };
	await saveFilteredResponse(result);
	return result;
}

// ============================================================================
// BLUEPRINTS MANAGEMENT
// ============================================================================

async function create_blueprint(input: {
	displayName: string;
	contentType: string;
	properties?: JsonObject;
}): Promise<JsonObject> {
	const payload: JsonObject = {
		displayName: input.displayName,
		contentType: input.contentType,
		content: {
			properties: input.properties || {},
		},
	};

	const result = await makeRestRequest('POST', '/blueprints', payload);
	await saveFilteredResponse(result);
	return result;
}

async function get_blueprint(input: { key: string }): Promise<JsonObject> {
	const result = await makeRestRequest('GET', `/blueprints/${input.key}`);
	await saveFilteredResponse(result);
	return result;
}

async function list_blueprints(input: { limit?: number } = {}): Promise<JsonObject> {
	let endpoint = '/blueprints';
	if (input.limit) {
		endpoint += `?pageSize=${input.limit}`;
	}

	const result = await makeRestRequest('GET', endpoint);
	await saveFilteredResponse(result);
	return result;
}

async function update_blueprint(input: {
	key: string;
	displayName?: string;
	properties?: JsonObject;
}): Promise<JsonObject> {
	const payload: JsonObject = {};

	if (input.displayName) payload.displayName = input.displayName;
	if (input.properties) payload.content = { properties: input.properties };

	const result = await makeRestRequest(
		'PATCH',
		`/blueprints/${input.key}`,
		payload,
		{ headers: { 'Content-Type': 'application/merge-patch+json' } }
	);
	await saveFilteredResponse(result);
	return result;
}

async function delete_blueprint(input: { key: string }): Promise<JsonObject> {
	const result = await makeRestRequest('DELETE', `/blueprints/${input.key}`);
	await saveFilteredResponse(result);
	return result;
}

// ============================================================================
// CONTENT SOURCES MANAGEMENT
// ============================================================================

async function create_content_source(input: {
	key: string;
	displayName: string;
	sourceKey: string;
	sourceType: string;
	baseType: string;
	propertyMappings?: JsonObject;
}): Promise<JsonObject> {
	const payload: JsonObject = {
		key: input.key,
		displayName: input.displayName,
		sourceKey: input.sourceKey,
		sourceType: input.sourceType,
		type: 'graph',
		baseType: input.baseType,
		propertyMappings: input.propertyMappings || { key: 'id', displayName: 'name' },
	};

	const result = await makeRestRequest('POST', '/contentsources', payload);
	await saveFilteredResponse(result);
	return result;
}

async function get_content_source(input: { key: string }): Promise<JsonObject> {
	const result = await makeRestRequest('GET', `/contentsources/${input.key}`);
	await saveFilteredResponse(result);
	return result;
}

async function list_content_sources(input: { limit?: number } = {}): Promise<JsonObject> {
	let endpoint = '/contentsources';
	if (input.limit) {
		endpoint += `?pageSize=${input.limit}`;
	}

	const result = await makeRestRequest('GET', endpoint);
	await saveFilteredResponse(result);
	return result;
}

async function update_content_source(input: {
	key: string;
	displayName?: string;
	propertyMappings?: JsonObject;
}): Promise<JsonObject> {
	const payload: JsonObject = {};

	if (input.displayName) payload.displayName = input.displayName;
	if (input.propertyMappings) payload.propertyMappings = input.propertyMappings;

	const result = await makeRestRequest(
		'PATCH',
		`/contentsources/${input.key}`,
		payload,
		{ headers: { 'Content-Type': 'application/merge-patch+json' } }
	);
	await saveFilteredResponse(result);
	return result;
}

async function delete_content_source(input: { key: string }): Promise<JsonObject> {
	const result = await makeRestRequest('DELETE', `/contentsources/${input.key}`);
	await saveFilteredResponse(result);
	return result;
}

// ============================================================================
// CONTENT TYPE BINDINGS MANAGEMENT
// ============================================================================

async function create_content_type_binding(input: {
	from: string;
	to: string;
	propertyMappings?: JsonObject;
}): Promise<JsonObject> {
	const payload: JsonObject = {
		from: input.from,
		to: input.to,
	};

	if (input.propertyMappings) payload.propertyMappings = input.propertyMappings;

	const result = await makeRestRequest('POST', '/contenttypebindings', payload);
	await saveFilteredResponse(result);
	return result;
}

async function get_content_type_binding(input: { key: string }): Promise<JsonObject> {
	const result = await makeRestRequest('GET', `/contenttypebindings/${input.key}`);
	await saveFilteredResponse(result);
	return result;
}

async function list_content_type_bindings(input: { limit?: number } = {}): Promise<JsonObject> {
	let endpoint = '/contenttypebindings';
	if (input.limit) {
		endpoint += `?pageSize=${input.limit}`;
	}

	const result = await makeRestRequest('GET', endpoint);
	await saveFilteredResponse(result);
	return result;
}

async function update_content_type_binding(input: {
	key: string;
	propertyMappings?: JsonObject;
}): Promise<JsonObject> {
	const payload: JsonObject = {};

	if (input.propertyMappings) payload.propertyMappings = input.propertyMappings;

	const result = await makeRestRequest(
		'PATCH',
		`/contenttypebindings/${input.key}`,
		payload,
		{ headers: { 'Content-Type': 'application/merge-patch+json' } }
	);
	await saveFilteredResponse(result);
	return result;
}

async function delete_content_type_binding(input: { key: string }): Promise<JsonObject> {
	const result = await makeRestRequest('DELETE', `/contenttypebindings/${input.key}`);
	await saveFilteredResponse(result);
	return result;
}

// ============================================================================
// MCP TOOL DEFINITIONS
// ============================================================================

const tools = [
	{
		name: 'cma_create_content_type',
		description: 'Create a new content type in Optimizely CMS',
		inputSchema: {
			type: 'object',
			properties: {
				key: { type: 'string', description: 'Unique identifier for content type' },
				baseType: { type: 'string', description: 'Base type (_page, _component, _element, _media, _image, _video)' },
				displayName: { type: 'string', description: 'Display name shown in UI' },
				description: { type: 'string', description: 'Optional description' },
				properties: { type: 'object', description: 'Content type properties schema' },
				fields: {
					type: 'array',
					description: 'Field definitions; easier input than raw properties',
					items: {
						type: 'object',
						properties: {
							name: { type: 'string', description: 'Field key (for example: heading)' },
							type: { type: 'string', description: 'Field type (string, richText, contentReference, url)' },
							displayName: { type: 'string' },
							description: { type: 'string' },
							required: { type: 'boolean' },
							localized: { type: 'boolean' },
							allowedTypes: { type: 'array', items: { type: 'string' } },
							restrictedTypes: { type: 'array', items: { type: 'string' } },
							mediaOnly: { type: 'boolean', description: 'When true and type is contentReference, allowedTypes becomes ["_media"]' },
						},
						required: ['name', 'type'],
					},
				},
			},
			required: ['key', 'baseType', 'displayName'],
		},
	},
	{
		name: 'cma_get_content_type',
		description: 'Retrieve a specific content type',
		inputSchema: {
			type: 'object',
			properties: {
				key: { type: 'string', description: 'Content type key' },
			},
			required: ['key'],
		},
	},
	{
		name: 'cma_list_content_types',
		description: 'List all content types with optional filtering',
		inputSchema: {
			type: 'object',
			properties: {
				search: { type: 'string', description: 'Search filter for content type names' },
				limit: { type: 'number', description: 'Maximum results to return' },
			},
		},
	},
	{
		name: 'cma_update_content_type',
		description: 'Update an existing content type',
		inputSchema: {
			type: 'object',
			properties: {
				key: { type: 'string', description: 'Content type key' },
				displayName: { type: 'string', description: 'New display name' },
				description: { type: 'string', description: 'New description' },
				properties: { type: 'object', description: 'Updated properties schema' },
				fields: {
					type: 'array',
					description: 'Field definitions to merge/update',
					items: {
						type: 'object',
						properties: {
							name: { type: 'string' },
							type: { type: 'string' },
							displayName: { type: 'string' },
							description: { type: 'string' },
							required: { type: 'boolean' },
							localized: { type: 'boolean' },
							allowedTypes: { type: 'array', items: { type: 'string' } },
							restrictedTypes: { type: 'array', items: { type: 'string' } },
							mediaOnly: { type: 'boolean' },
						},
						required: ['name', 'type'],
					},
				},
				ignoreDataLossWarnings: { type: 'boolean', description: 'Set true to apply breaking field-type changes' },
			},
			required: ['key'],
		},
	},
	{
		name: 'cma_upsert_content_type',
		description: 'Create content type if missing, otherwise update the same content type with provided fields/properties',
		inputSchema: {
			type: 'object',
			properties: {
				key: { type: 'string', description: 'Content type key' },
				baseType: { type: 'string', description: 'Used on create; defaults to _component' },
				displayName: { type: 'string', description: 'Used on create or update display name' },
				description: { type: 'string', description: 'Used on create or update description' },
				properties: { type: 'object', description: 'Raw content type properties schema' },
				fields: {
					type: 'array',
					description: 'Field definitions (recommended)',
					items: {
						type: 'object',
						properties: {
							name: { type: 'string' },
							type: { type: 'string' },
							displayName: { type: 'string' },
							description: { type: 'string' },
							required: { type: 'boolean' },
							localized: { type: 'boolean' },
							allowedTypes: { type: 'array', items: { type: 'string' } },
							restrictedTypes: { type: 'array', items: { type: 'string' } },
							mediaOnly: { type: 'boolean' },
						},
						required: ['name', 'type'],
					},
				},
				ignoreDataLossWarnings: { type: 'boolean', description: 'Set true to apply breaking field-type changes on update' },
			},
			required: ['key'],
		},
	},
	{
		name: 'cma_delete_content_type',
		description: 'Delete a content type',
		inputSchema: {
			type: 'object',
			properties: {
				key: { type: 'string', description: 'Content type key' },
			},
			required: ['key'],
		},
	},
	{
		name: 'cma_create_content',
		description: 'Create a new content item',
		inputSchema: {
			type: 'object',
			properties: {
				key: { type: 'string', description: 'UUID-like identifier' },
				contentType: { type: 'string', description: 'Content type key' },
				container: { type: 'string', description: 'Parent container key' },
				displayName: { type: 'string', description: 'Content display name' },
				locale: { type: 'string', description: 'Locale (default: en)' },
				properties: { type: 'object', description: 'Content properties matching schema' },
			},
			required: ['key', 'contentType', 'container', 'displayName'],
		},
	},
	{
		name: 'cma_get_content',
		description: 'Retrieve content item metadata',
		inputSchema: {
			type: 'object',
			properties: {
				key: { type: 'string', description: 'Content item key' },
			},
			required: ['key'],
		},
	},
	{
		name: 'cma_list_content_items',
		description: 'List child content items under a parent',
		inputSchema: {
			type: 'object',
			properties: {
				parentKey: { type: 'string', description: 'Parent content key' },
				contentTypes: { type: 'array', items: { type: 'string' }, description: 'Filter by content types' },
				limit: { type: 'number', description: 'Maximum results' },
			},
			required: ['parentKey'],
		},
	},
	{
		name: 'cma_get_content_versions',
		description: 'List versions of a content item',
		inputSchema: {
			type: 'object',
			properties: {
				contentKey: { type: 'string', description: 'Content item key' },
				locales: { type: 'array', items: { type: 'string' }, description: 'Filter by locales' },
				statuses: { type: 'array', items: { type: 'string' }, description: 'Filter by statuses' },
			},
			required: ['contentKey'],
		},
	},
	{
		name: 'cma_get_content_version',
		description: 'Retrieve a specific content version',
		inputSchema: {
			type: 'object',
			properties: {
				contentKey: { type: 'string', description: 'Content item key' },
				versionId: { type: 'string', description: 'Version identifier' },
			},
			required: ['contentKey', 'versionId'],
		},
	},
	{
		name: 'cma_create_content_version',
		description: 'Create a new version of existing content',
		inputSchema: {
			type: 'object',
			properties: {
				contentKey: { type: 'string', description: 'Content item key' },
				displayName: { type: 'string', description: 'Version display name' },
				locale: { type: 'string', description: 'Locale for this version' },
				properties: { type: 'object', description: 'Version properties' },
			},
			required: ['contentKey', 'displayName', 'locale'],
		},
	},
	{
		name: 'cma_update_content_version',
		description: 'Update a content version',
		inputSchema: {
			type: 'object',
			properties: {
				contentKey: { type: 'string', description: 'Content item key' },
				versionId: { type: 'string', description: 'Version identifier' },
				displayName: { type: 'string', description: 'New display name' },
				properties: { type: 'object', description: 'Updated properties' },
			},
			required: ['contentKey', 'versionId'],
		},
	},
	{
		name: 'cma_publish_content',
		description: 'Publish a content version',
		inputSchema: {
			type: 'object',
			properties: {
				contentKey: { type: 'string', description: 'Content item key' },
				versionId: { type: 'string', description: 'Version identifier' },
				delayUntil: { type: 'string', description: 'ISO timestamp for scheduled publish' },
				force: { type: 'boolean', description: 'Force publish bypassing validations' },
			},
			required: ['contentKey', 'versionId'],
		},
	},
	{
		name: 'cma_ready_content',
		description: 'Mark a content version as ready for approval',
		inputSchema: {
			type: 'object',
			properties: {
				contentKey: { type: 'string', description: 'Content item key' },
				versionId: { type: 'string', description: 'Version identifier' },
				comment: { type: 'string', description: 'Optional comment' },
			},
			required: ['contentKey', 'versionId'],
		},
	},
	{
		name: 'cma_draft_content',
		description: 'Move a content version back to draft',
		inputSchema: {
			type: 'object',
			properties: {
				contentKey: { type: 'string', description: 'Content item key' },
				versionId: { type: 'string', description: 'Version identifier' },
			},
			required: ['contentKey', 'versionId'],
		},
	},
	{
		name: 'cma_delete_content',
		description: 'Delete a content item',
		inputSchema: {
			type: 'object',
			properties: {
				contentKey: { type: 'string', description: 'Content item key' },
				permanent: { type: 'boolean', description: 'Permanently delete (default: soft delete)' },
			},
			required: ['contentKey'],
		},
	},
	{
		name: 'cma_create_media',
		description: 'Upload and create media content',
		inputSchema: {
			type: 'object',
			properties: {
				contentType: { type: 'string', description: 'Media content type (ImageMedia, etc)' },
				container: { type: 'string', description: 'Parent container key' },
				displayName: { type: 'string', description: 'Display name' },
				filePath: { type: 'string', description: 'Local file path to upload' },
				fileType: { type: 'string', description: 'MIME type (auto-detected if not provided)' },
			},
			required: ['contentType', 'container', 'displayName', 'filePath'],
		},
	},
	{
		name: 'cma_get_media',
		description: 'Download media content',
		inputSchema: {
			type: 'object',
			properties: {
				contentKey: { type: 'string', description: 'Media content key' },
				versionId: { type: 'string', description: 'Version identifier' },
				outputPath: { type: 'string', description: 'Save location (default: out/media)' },
			},
			required: ['contentKey', 'versionId'],
		},
	},
	{
		name: 'cma_create_blueprint',
		description: 'Create a blueprint template',
		inputSchema: {
			type: 'object',
			properties: {
				displayName: { type: 'string', description: 'Blueprint display name' },
				contentType: { type: 'string', description: 'Target content type' },
				properties: { type: 'object', description: 'Blueprint properties' },
			},
			required: ['displayName', 'contentType'],
		},
	},
	{
		name: 'cma_get_blueprint',
		description: 'Retrieve a blueprint',
		inputSchema: {
			type: 'object',
			properties: {
				key: { type: 'string', description: 'Blueprint key' },
			},
			required: ['key'],
		},
	},
	{
		name: 'cma_list_blueprints',
		description: 'List all blueprints',
		inputSchema: {
			type: 'object',
			properties: {
				limit: { type: 'number', description: 'Maximum results' },
			},
		},
	},
	{
		name: 'cma_update_blueprint',
		description: 'Update a blueprint',
		inputSchema: {
			type: 'object',
			properties: {
				key: { type: 'string', description: 'Blueprint key' },
				displayName: { type: 'string', description: 'New display name' },
				properties: { type: 'object', description: 'Updated properties' },
			},
			required: ['key'],
		},
	},
	{
		name: 'cma_delete_blueprint',
		description: 'Delete a blueprint',
		inputSchema: {
			type: 'object',
			properties: {
				key: { type: 'string', description: 'Blueprint key' },
			},
			required: ['key'],
		},
	},
	{
		name: 'cma_create_content_source',
		description: 'Create a content source for external data',
		inputSchema: {
			type: 'object',
			properties: {
				key: { type: 'string', description: 'Source key (alphanumeric + underscore)' },
				displayName: { type: 'string', description: 'Display name' },
				sourceKey: { type: 'string', description: 'Graph source key' },
				sourceType: { type: 'string', description: 'Graph source type' },
				baseType: { type: 'string', description: 'CMS base type' },
				propertyMappings: { type: 'object', description: 'Property mappings' },
			},
			required: ['key', 'displayName', 'sourceKey', 'sourceType', 'baseType'],
		},
	},
	{
		name: 'cma_get_content_source',
		description: 'Retrieve a content source',
		inputSchema: {
			type: 'object',
			properties: {
				key: { type: 'string', description: 'Content source key' },
			},
			required: ['key'],
		},
	},
	{
		name: 'cma_list_content_sources',
		description: 'List all content sources',
		inputSchema: {
			type: 'object',
			properties: {
				limit: { type: 'number', description: 'Maximum results' },
			},
		},
	},
	{
		name: 'cma_update_content_source',
		description: 'Update a content source',
		inputSchema: {
			type: 'object',
			properties: {
				key: { type: 'string', description: 'Content source key' },
				displayName: { type: 'string', description: 'New display name' },
				propertyMappings: { type: 'object', description: 'Updated property mappings' },
			},
			required: ['key'],
		},
	},
	{
		name: 'cma_delete_content_source',
		description: 'Delete a content source',
		inputSchema: {
			type: 'object',
			properties: {
				key: { type: 'string', description: 'Content source key' },
			},
			required: ['key'],
		},
	},
	{
		name: 'cma_create_content_type_binding',
		description: 'Create a binding between two content types',
		inputSchema: {
			type: 'object',
			properties: {
				from: { type: 'string', description: 'Source content type' },
				to: { type: 'string', description: 'Target content type' },
				propertyMappings: { type: 'object', description: 'Property mappings' },
			},
			required: ['from', 'to'],
		},
	},
	{
		name: 'cma_get_content_type_binding',
		description: 'Retrieve a content type binding',
		inputSchema: {
			type: 'object',
			properties: {
				key: { type: 'string', description: 'Binding key' },
			},
			required: ['key'],
		},
	},
	{
		name: 'cma_list_content_type_bindings',
		description: 'List all content type bindings',
		inputSchema: {
			type: 'object',
			properties: {
				limit: { type: 'number', description: 'Maximum results' },
			},
		},
	},
	{
		name: 'cma_update_content_type_binding',
		description: 'Update a content type binding',
		inputSchema: {
			type: 'object',
			properties: {
				key: { type: 'string', description: 'Binding key' },
				propertyMappings: { type: 'object', description: 'Updated property mappings' },
			},
			required: ['key'],
		},
	},
	{
		name: 'cma_delete_content_type_binding',
		description: 'Delete a content type binding',
		inputSchema: {
			type: 'object',
			properties: {
				key: { type: 'string', description: 'Binding key' },
			},
			required: ['key'],
		},
	},
	{
		name: 'cma_get_auth_token',
		description: 'Get or refresh OAuth authentication token',
		inputSchema: {
			type: 'object',
			properties: {},
		},
	},
];

// ============================================================================
// MCP SERVER SETUP
// ============================================================================

async function processTool(
	name: string,
	args: Record<string, unknown>
): Promise<string> {
	try {
		let result: unknown;

		switch (name) {
			case 'cma_create_content_type':
				result = await create_content_type(args as Parameters<typeof create_content_type>[0]);
				break;
			case 'cma_get_content_type':
				result = await get_content_type(args as Parameters<typeof get_content_type>[0]);
				break;
			case 'cma_list_content_types':
				result = await list_content_types(args as Parameters<typeof list_content_types>[0]);
				break;
			case 'cma_update_content_type':
				result = await update_content_type(args as Parameters<typeof update_content_type>[0]);
				break;
			case 'cma_upsert_content_type':
				result = await upsert_content_type(args as Parameters<typeof upsert_content_type>[0]);
				break;
			case 'cma_delete_content_type':
				result = await delete_content_type(args as Parameters<typeof delete_content_type>[0]);
				break;
			case 'cma_create_content':
				result = await create_content(args as Parameters<typeof create_content>[0]);
				break;
			case 'cma_get_content':
				result = await get_content(args as Parameters<typeof get_content>[0]);
				break;
			case 'cma_list_content_items':
				result = await list_content_items(args as Parameters<typeof list_content_items>[0]);
				break;
			case 'cma_get_content_versions':
				result = await get_content_versions(args as Parameters<typeof get_content_versions>[0]);
				break;
			case 'cma_get_content_version':
				result = await get_content_version(args as Parameters<typeof get_content_version>[0]);
				break;
			case 'cma_create_content_version':
				result = await create_content_version(args as Parameters<typeof create_content_version>[0]);
				break;
			case 'cma_update_content_version':
				result = await update_content_version(args as Parameters<typeof update_content_version>[0]);
				break;
			case 'cma_publish_content':
				result = await publish_content(args as Parameters<typeof publish_content>[0]);
				break;
			case 'cma_ready_content':
				result = await ready_content(args as Parameters<typeof ready_content>[0]);
				break;
			case 'cma_draft_content':
				result = await draft_content(args as Parameters<typeof draft_content>[0]);
				break;
			case 'cma_delete_content':
				result = await delete_content(args as Parameters<typeof delete_content>[0]);
				break;
			case 'cma_create_media':
				result = await create_media(args as Parameters<typeof create_media>[0]);
				break;
			case 'cma_get_media':
				result = await get_media(args as Parameters<typeof get_media>[0]);
				break;
			case 'cma_create_blueprint':
				result = await create_blueprint(args as Parameters<typeof create_blueprint>[0]);
				break;
			case 'cma_get_blueprint':
				result = await get_blueprint(args as Parameters<typeof get_blueprint>[0]);
				break;
			case 'cma_list_blueprints':
				result = await list_blueprints(args as Parameters<typeof list_blueprints>[0]);
				break;
			case 'cma_update_blueprint':
				result = await update_blueprint(args as Parameters<typeof update_blueprint>[0]);
				break;
			case 'cma_delete_blueprint':
				result = await delete_blueprint(args as Parameters<typeof delete_blueprint>[0]);
				break;
			case 'cma_create_content_source':
				result = await create_content_source(args as Parameters<typeof create_content_source>[0]);
				break;
			case 'cma_get_content_source':
				result = await get_content_source(args as Parameters<typeof get_content_source>[0]);
				break;
			case 'cma_list_content_sources':
				result = await list_content_sources(args as Parameters<typeof list_content_sources>[0]);
				break;
			case 'cma_update_content_source':
				result = await update_content_source(args as Parameters<typeof update_content_source>[0]);
				break;
			case 'cma_delete_content_source':
				result = await delete_content_source(args as Parameters<typeof delete_content_source>[0]);
				break;
			case 'cma_create_content_type_binding':
				result = await create_content_type_binding(args as Parameters<typeof create_content_type_binding>[0]);
				break;
			case 'cma_get_content_type_binding':
				result = await get_content_type_binding(args as Parameters<typeof get_content_type_binding>[0]);
				break;
			case 'cma_list_content_type_bindings':
				result = await list_content_type_bindings(args as Parameters<typeof list_content_type_bindings>[0]);
				break;
			case 'cma_update_content_type_binding':
				result = await update_content_type_binding(args as Parameters<typeof update_content_type_binding>[0]);
				break;
			case 'cma_delete_content_type_binding':
				result = await delete_content_type_binding(args as Parameters<typeof delete_content_type_binding>[0]);
				break;
			case 'cma_get_auth_token':
				result = await getValidToken();
				break;
			default:
				throw new Error(`Unknown tool: ${name}`);
		}

		return JSON.stringify({ success: true, data: result });
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		return JSON.stringify({ success: false, error: errorMsg });
	}
}

async function main(): Promise<void> {
	await ensureDirectories();

	const server = new Server(
		{
			name: SERVER_NAME,
			version: SERVER_VERSION,
		},
		{
			capabilities: {
				tools: {},
			},
		}
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools,
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name, arguments: args } = request.params;
		const result = await processTool(name, args as Record<string, unknown>);

		return {
			content: [
				{
					type: 'text',
					text: result,
				},
			],
		};
	});

	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch(console.error);
