import { config } from "zod";
import { registeredObjectParser } from "./schema-parser-registry";

// Use prebuilt object parsers; other browser schemas retain the interpreter.
// Server validation keeps its normal execution mode.
config({ jitless: true, staticObjectParser: registeredObjectParser });
