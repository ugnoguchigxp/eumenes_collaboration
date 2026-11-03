import { buildCollaborationMessages, type TurnContext } from "../src/index.ts";

// One saved step in, one prompt out. The caller owns persistence and model I/O.
const path = process.argv[2];
if (!path) throw new Error("usage: bun run standalone <turn-context.json>");
const input = (await Bun.file(path).json()) as TurnContext;
console.log(JSON.stringify(buildCollaborationMessages(input)));
