# Optimizely SaaS MCP Server (Graph + CMA REST API)

This project provides MCP tools for both **reading** (via Optimizely Graph) and **writing** (via CMA REST API) to Optimizely SaaS CMS.

## Capabilities

### Graph API (Read-Only)
- listing content types
- describing content type schema
- fetching content and media information
- running raw GraphQL queries
- parsing natural language into Graph queries
- saving generated queries into `query/temp.graphql`
- saving responses into `out/data.json`

### CMA REST API (Write Operations)
- managing content types (create, read, update, delete)
- managing content items (create, read, list, update, publish, schedule, draft)
- managing media (upload, download)
- managing blueprints (create, read, list, update, delete)
- managing content sources (create, read, update, delete)
- managing content type bindings (create, read, update, delete)
- automatic OAuth token generation and caching

## Project purpose

As an Optimizely SaaS developer, you can use this MCP server to:
- **Query** SaaS CMS data through Optimizely Graph (read-only)
- **Manage** SaaS CMS content, types, media, and configurations through CMA REST API (write operations)
- Combine both read and write operations in your workflows

## Configuration

Environment variables are loaded from `.env`.

### Required Graph settings
- `GRAPH_ENDPOINT`
- `GRAPH_AUTH_METHOD`
- `GRAPH_SINGLE_KEY` when using `single_key`
- `GRAPH_BEARER_TOKEN` when using `bearer`

### Required CMA settings
- `CMA_BASE_URL` (default: `https://api.cms.optimizely.com/v1`)
- `CMA_CLIENT_ID`
- `CMA_CLIENT_SECRET`
- `CMA_GRANT_TYPE` (default: `client_credentials`)
- `CMA_TOKEN_ENDPOINT` (default: `https://api.cms.optimizely.com/oauth/token`)

### Optional save-path setting
- `DATA_SAVE_PATH` (absolute or project-relative file path)
  - When set, tools that persist response data save to this path by default.
  - You can still override per call using tool input `outputPath`.

### Current behavior
- Graph queries are saved in `query/temp.graphql` and overwritten on each saved execution
- REST API payloads are saved in `query/temp.rest.txt` and overwritten on each execution
- Latest responses are saved in `DATA_SAVE_PATH` (when set) or `out/data.json`
- CMA OAuth tokens are cached in `auth/token.txt` and automatically refreshed when expired
- Documentation/reference links are read from `rag/cma-document.txt` and `rag/document.txt`

## Build and run

### Build
```bash
npm run build
```

### Start MCP server
```bash
npm start
```

### Self-test
```bash
npm run self-test
```

## MCP server configuration

The MCP servers are configured in `.vscode/mcp.json`:
- **Graph API Server:** `node dist/cd-graph-index.js`
- **CMA REST API Server:** `node dist/cm-restapi-index.js`

Both servers run independently and do not conflict with each other.

## Available Graph API Tools (Read-Only)

---

## 1. `graph_nl_query`
Parses a natural-language request into an Optimizely Graph query or introspection query, executes it, optionally saves the generated query into `query/temp.graphql` (overwrite), and saves the response to `out/data.json`.

### Input
- `request` *(required)* — natural-language request
- `limit` *(optional)* — numeric result limit
- `saveQuery` *(optional)* — whether to save the generated query
- `outputPath` *(optional)* — save response JSON to a custom path for this call

### Example
```json
{
  "request": "get top 5 BlogPostPage items",
  "limit": 5,
  "saveQuery": true
}
```

### More examples
```json
{
  "request": "list content types"
}
```

```json
{
  "request": "describe BlogPostPage fields"
}
```

```json
{
  "request": "get top 10 media items"
}
```

### Use when
- you do not want to write GraphQL manually
- you want quick content/schema discovery
- you want the generated query saved automatically

---

## 2. `graph_list_content_types`
Reads available Optimizely SaaS CMS content types from the Optimizely Graph schema using introspection only.

### Input
- `search` *(optional)* — text filter for content type names
- `outputPath` *(optional)* — save response JSON to a custom path for this call

### Example
```json
{
  "search": "Blog"
}
```

### Output behavior
- reads schema from Graph
- returns matching content types
- saves response to `out/data.json`

### Use when
- you want to discover available content types
- you need the exact content type name before querying

---

## 3. `graph_describe_content_type`
Describes a specific Optimizely Graph content type, including root arguments and available item fields.

### Input
- `typeName` *(required)* — exact Graph content type name
- `outputPath` *(optional)* — save response JSON to a custom path for this call

### Example
```json
{
  "typeName": "BlogPostPage"
}
```

### Output behavior
Returns:
- root field name
- root arguments
- result type name
- item type name
- available item fields

### Use when
- you want to inspect the schema for one content type
- you need field names before writing a query

---

## 4. `graph_execute_query`
Executes a raw Optimizely Graph query directly, optionally saves the query into `query/temp.graphql` (overwrite), and always persists the response to `out/data.json`.

### Input
- `query` *(required)* — raw GraphQL query string
- `variablesJson` *(optional)* — JSON string of GraphQL variables
- `saveQuery` *(optional)* — whether to overwrite `query/temp.graphql`
- `queryName` *(optional)* — deprecated and ignored
- `outputPath` *(optional)* — save response JSON to a custom path for this call

### Example
```json
{
  "query": "query { BlogPostPage(limit: 3) { total items { _id Name } } }",
  "saveQuery": true
}
```

### Example with variables
```json
{
  "query": "query TypeDetails($name: String!) { __type(name: $name) { name kind } }",
  "variablesJson": "{\"name\":\"BlogPostPage\"}",
  "saveQuery": true
}
```

### Use when
- you already know the GraphQL you want
- you need full control over query structure
- you want to test introspection or advanced queries directly

---

## 5. `graph_reference_links`
Reads the local Graph reference links from `rag/document.txt`.

### Input
```json
{}
```

### Use when
- you need the saved Optimizely Graph reference links
- you want documentation context before creating queries

---

## Recommended usage flow

### Natural language flow
1. Use `graph_nl_query`
2. Example:
```json
{
  "request": "list content types"
}
```

### Schema-first flow
1. Use `graph_list_content_types`
2. Pick a content type such as `BlogPostPage`
3. Use `graph_describe_content_type`
4. Use `graph_execute_query` or `graph_nl_query`

## Available CMA REST API Tools (Write Operations)

These tools manage Optimizely CMS SaaS content, types, media, and configurations via REST API.

---

## CMA Authentication

### `cma_get_auth_token`
Gets or refreshes the current OAuth authentication token.

- Automatically caches tokens in `auth/token.txt`
- Validates token expiration and auto-refreshes when expired
- Returns the active bearer token

**Use when:**
- You need to check current token status
- You want to force token refresh

---

## CMA Content Types Management

### `cma_create_content_type`
Create a new content type.

**Required inputs:** `key`, `baseType`, `displayName`  
**Optional inputs:** `description`, `properties`, `fields`

### `cma_get_content_type`
Retrieve a specific content type by key.

**Required inputs:** `key`

### `cma_list_content_types`
List all content types with optional filtering.

**Optional inputs:** `search`, `limit`

### `cma_update_content_type`
Update an existing content type.

**Required inputs:** `key`  
**Optional inputs:** `displayName`, `description`, `properties`, `fields`, `ignoreDataLossWarnings`

### `cma_upsert_content_type`
Create if missing, otherwise update the same content type.

**Required inputs:** `key`  
**Optional inputs:** `baseType`, `displayName`, `description`, `properties`, `fields`, `ignoreDataLossWarnings`

### `cma_delete_content_type`
Delete a content type.

**Required inputs:** `key`

---

## CMA Content Management

### `cma_create_content`
Create a new content item with initial version.

**Required inputs:** `key`, `contentType`, `container`, `displayName`  
**Optional inputs:** `locale`, `properties`

### `cma_get_content`
Retrieve content item metadata.

**Required inputs:** `key`

### `cma_list_content_items`
List child content items under a parent.

**Required inputs:** `parentKey`  
**Optional inputs:** `contentTypes`, `limit`

### `cma_get_content_versions`
List all versions of a content item.

**Required inputs:** `contentKey`  
**Optional inputs:** `locales`, `statuses`

### `cma_get_content_version`
Retrieve a specific content version.

**Required inputs:** `contentKey`, `versionId`

### `cma_create_content_version`
Create a new version of existing content.

**Required inputs:** `contentKey`, `displayName`, `locale`  
**Optional inputs:** `properties`

### `cma_update_content_version`
Update a content version.

**Required inputs:** `contentKey`, `versionId`  
**Optional inputs:** `displayName`, `properties`

### `cma_publish_content`
Publish a content version (immediately or scheduled).

**Required inputs:** `contentKey`, `versionId`  
**Optional inputs:** `delayUntil`, `force`

### `cma_ready_content`
Mark a content version as ready for approval.

**Required inputs:** `contentKey`, `versionId`  
**Optional inputs:** `comment`

### `cma_draft_content`
Move a content version back to draft status.

**Required inputs:** `contentKey`, `versionId`

### `cma_delete_content`
Delete a content item (soft or permanent).

**Required inputs:** `contentKey`  
**Optional inputs:** `permanent`

---

## CMA Media Management

### `cma_create_media`
Upload and create media content (images, videos, documents).

**Required inputs:** `contentType`, `container`, `displayName`, `filePath`  
**Optional inputs:** `fileType`

### `cma_get_media`
Download media content binary.

**Required inputs:** `contentKey`, `versionId`  
**Optional inputs:** `outputPath`

---

## CMA Blueprints Management

### `cma_create_blueprint`
Create a blueprint template for content types.

**Required inputs:** `displayName`, `contentType`  
**Optional inputs:** `properties`

### `cma_get_blueprint`
Retrieve a blueprint by key.

**Required inputs:** `key`

### `cma_list_blueprints`
List all blueprints.

**Optional inputs:** `limit`

### `cma_update_blueprint`
Update a blueprint.

**Required inputs:** `key`  
**Optional inputs:** `displayName`, `properties`

### `cma_delete_blueprint`
Delete a blueprint.

**Required inputs:** `key`

---

## CMA Content Sources Management

### `cma_create_content_source`
Create a content source for external data integration.

**Required inputs:** `key`, `displayName`, `sourceKey`, `sourceType`, `baseType`  
**Optional inputs:** `propertyMappings`

### `cma_get_content_source`
Retrieve a content source.

**Required inputs:** `key`

### `cma_list_content_sources`
List all content sources.

**Optional inputs:** `limit`

### `cma_update_content_source`
Update a content source.

**Required inputs:** `key`  
**Optional inputs:** `displayName`, `propertyMappings`

### `cma_delete_content_source`
Delete a content source.

**Required inputs:** `key`

---

## CMA Content Type Bindings Management

### `cma_create_content_type_binding`
Create a binding between two content types for data mapping.

**Required inputs:** `from`, `to`  
**Optional inputs:** `propertyMappings`

### `cma_get_content_type_binding`
Retrieve a content type binding.

**Required inputs:** `key`

### `cma_list_content_type_bindings`
List all content type bindings.

**Optional inputs:** `limit`

### `cma_update_content_type_binding`
Update a content type binding.

**Required inputs:** `key`  
**Optional inputs:** `propertyMappings`

### `cma_delete_content_type_binding`
Delete a content type binding.

**Required inputs:** `key`

---

## Recommended combined workflows

### Graph + CMA Workflow (Read + Write)
1. Use `graph_list_content_types` to discover available types
2. Use `cma_create_content_type` to define custom types
3. Use `cma_create_content` to create content items
4. Use `graph_nl_query` to fetch published content
5. Use `cma_publish_content` to make content live

### Content Management Workflow
1. Use `cma_list_content_types` to review available types
2. Use `cma_create_content` to create draft content
3. Use `cma_create_content_version` to add translations
4. Use `cma_ready_content` to prepare for review
5. Use `cma_publish_content` to publish

## Files used by this project
- `src/cd-graph-index.ts` — Graph API MCP server implementation
- `src/cm-restapi-index.ts` — CMA REST API MCP server implementation
- `.vscode/mcp.json` — MCP servers registration
- `.env` — environment variables for Graph and CMA credentials
- `query/temp.graphql` — latest generated Graph query
- `query/temp.rest.txt` — latest REST API request details
- `out/data.json` — latest saved response (filtered)
- `auth/token.txt` — cached OAuth token for CMA
- `rag/document.txt` — Graph API reference documentation
- `rag/cma-document.txt` — CMA REST API reference documentation

## Notes
- Graph API is **read-only** for querying content through Optimizely Graph
- CMA REST API is **write-enabled** for managing content, types, media, and configurations
- Both implementations are **completely separate** and do not conflict with each other
- Each server runs independently and can be used in parallel
- `cma_get_auth_token` automatically handles OAuth token generation, validation, and caching
- All REST API responses are filtered and saved to `out/data.json` per user request instructions
- Refer to `rag/cma-document.txt` for detailed CMA API specification
- If `NODE_TLS_REJECT_UNAUTHORIZED="0"` is set, TLS verification is disabled (troubleshooting only)
