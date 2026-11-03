declare module 'dynalite' {
  import type { Server } from 'node:http';
  export default function dynalite(opts?: { createTableMs?: number; deleteTableMs?: number; updateTableMs?: number; path?: string }): Server;
}
