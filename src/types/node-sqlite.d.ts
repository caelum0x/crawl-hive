// Встроенный node:sqlite (Node 22.13+). В @types/node ^20 его нет: описываем только то, чем пользуется memory-db.ts.
declare module "node:sqlite" {
  type Value = null | number | bigint | string | Uint8Array;
  export class StatementSync {
    run(...params: Value[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: Value[]): unknown;
    all(...params: Value[]): unknown[];
  }
  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean; readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
