/**
 * OpenAPI 3 document for the Bank Statement Extraction Service (Group 6).
 */

export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "Bank Statement Extraction Service",
    version: "8.0.0",
    description:
      "Extracts canonical transactions from bank statements (PDF, CSV, XLSX, images). When API_KEYS is configured, send Authorization: Bearer <key> or X-API-Key. Statement status/result require X-Access-Token from the extract response.",
  },
  servers: [{ url: "/", description: "Current host" }],
  paths: {
    "/api/health": {
      get: {
        summary: "Health check",
        responses: {
          "200": { description: "Service healthy" },
          "503": { description: "Service unavailable" },
        },
      },
    },
    "/api/v1/statements/extract": {
      post: {
        summary: "Synchronous statement extraction",
        description:
          "Accepts multipart file upload (field `file`) or JSON `{ source_type: \"url\", url }`. Both paths use the same pipeline.",
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                properties: {
                  file: { type: "string", format: "binary" },
                  password: { type: "string", nullable: true },
                },
                required: ["file"],
              },
            },
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  source_type: { type: "string", enum: ["url"] },
                  url: { type: "string", format: "uri" },
                  password: { type: "string", nullable: true },
                },
                required: ["url"],
              },
              examples: {
                urlExtract: {
                  value: {
                    source_type: "url",
                    url: "https://example.com/statement.pdf",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Extraction succeeded (or idempotent replay)",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ExtractionSuccess" },
              },
            },
          },
          "400": { description: "Invalid input / blocked URL" },
          "413": { description: "Payload too large" },
          "415": { description: "Unsupported media type" },
          "422": { description: "Valid request but invalid document content" },
          "500": { description: "Internal or database error" },
          "502": { description: "Upstream URL fetch failed" },
          "504": { description: "Upstream timeout" },
        },
      },
    },
    "/api/v1/statements": {
      post: {
        summary: "Enqueue asynchronous extraction",
        description: "Returns 202 immediately; poll status/result endpoints.",
        responses: {
          "202": { description: "Accepted for processing" },
          "400": { description: "Invalid input" },
        },
      },
    },
    "/api/v1/statements/{id}/status": {
      get: {
        summary: "Async extraction status",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "Status payload" },
          "404": { description: "Unknown statement id" },
        },
      },
    },
    "/api/v1/statements/{id}/result": {
      get: {
        summary: "Async extraction result",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "Completed result" },
          "202": { description: "Still processing" },
          "404": { description: "Unknown statement id" },
          "422": { description: "Processing failed" },
        },
      },
    },
    "/api/v1/statements/extract-url": {
      post: {
        summary: "URL extraction (alias)",
        responses: {
          "200": { description: "Success" },
          "400": { description: "Invalid / blocked URL" },
        },
      },
    },
    "/api/docs/openapi.json": {
      get: {
        summary: "OpenAPI document",
        responses: { "200": { description: "OpenAPI 3 JSON" } },
      },
    },
  },
  components: {
    schemas: {
      ExtractionSuccess: {
        type: "object",
        required: [
          "success",
          "statement",
          "transactions",
          "summary",
          "validation",
          "quality",
        ],
        properties: {
          success: { type: "boolean", enum: [true] },
          statement: { type: "object" },
          transactions: { type: "array", items: { type: "object" } },
          summary: { type: "object" },
          validation: { type: "object" },
          quality: { type: "object" },
        },
      },
      ErrorResponse: {
        type: "object",
        required: ["success", "error"],
        properties: {
          success: { type: "boolean", enum: [false] },
          error: {
            type: "object",
            required: ["code", "message"],
            properties: {
              code: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      },
    },
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "Optional — wire existing auth middleware when available",
      },
    },
  },
} as const;
