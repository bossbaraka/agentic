/**
 * تعريفات دنيا لـ node:sqlite (مدمج تجريبيًا في Node 22+).
 * نعتمد صراحةً على الأنواع الفرعية المُسخّرة داخل src/db/client.ts فقط،
 * حتى لا نتشابك مع اختلافات الأنواع بين إصدارات @types/node.
 */
declare module 'node:sqlite' {
  export interface SQLiteRunResult {
    changes: bigint | number;
    lastInsertRowid: bigint | number;
  }

  export class StatementSync {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): SQLiteRunResult;
    setAllowBareNamedParameters(enabled: boolean): void;
    setReadBigInts(enabled: boolean): void;
    finalize(): void;
  }

  export interface DatabaseSyncOptions {
    open?: boolean;
    readOnly?: boolean;
    enableForeignKeyConstraints?: boolean;
    enableDoubleQuotedStringLiterals?: boolean;
    allowExtension?: boolean;
  }

  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
    applyChangeset?(changeset: Uint8Array): void;
    createSession?(options?: { table: string; db?: string }): unknown;
  }

  export const SQLITE_OK: number;
}
