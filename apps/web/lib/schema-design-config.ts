import { staticObjectParser } from "./schema-object-parsers";
import { registerObjectParser } from "./schema-parser-registry";

// Load document parsers with design surfaces, keeping account pages lightweight.
registerObjectParser(staticObjectParser);
