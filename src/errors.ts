export interface AnypointApiErrorInit {
  status: number;
  statusText: string;
  url: string;
  body: unknown;
  retryAfterSeconds?: number;
}

export class AnypointApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly body: unknown;
  readonly retryAfterSeconds?: number;

  constructor({ status, statusText, url, body, retryAfterSeconds }: AnypointApiErrorInit) {
    super(`Anypoint API ${status} ${statusText}: ${formatErrorBody(body)}`);
    this.name = "AnypointApiError";
    this.status = status;
    this.statusText = statusText;
    this.url = url;
    this.body = body;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function formatErrorBody(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }

  if (body && typeof body === "object") {
    const record = body as Record<string, any>;

    if (record.message) {
      return String(record.message);
    }

    if (record.error) {
      return String(record.error);
    }

    if (Array.isArray(record.errors) && record.errors.length > 0) {
      return record.errors
        .map((error: any) => error.message || error.description || JSON.stringify(error))
        .join("; ");
    }
  }

  return JSON.stringify(body);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
