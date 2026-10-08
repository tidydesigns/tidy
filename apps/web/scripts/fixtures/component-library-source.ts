import { buildLibrarySource } from "../../lib/design/examples/component-libraries";
console.log(
  JSON.stringify({
    name: "Source library",
    document: { revision: 2, content: buildLibrarySource(2) },
  }),
);
