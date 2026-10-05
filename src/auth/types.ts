import type { ConnectionOptions } from 'node:tls';
export interface RequestContext { timeoutMs: number; signal?: AbortSignal }
export interface AuthResult { headers: Record<string,string>; tls?: ConnectionOptions }
export interface AuthProvider { prepareRequest(context: RequestContext): Promise<AuthResult> }
