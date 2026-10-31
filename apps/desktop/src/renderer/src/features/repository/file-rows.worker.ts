import { repositoryFileSchema } from "../../../../shared/contracts/repository-files";
import { highlightFileRows } from "./code-highlighting";
import { prepareFileRows } from "./file-rows";
import { z } from "zod";

const requestSchema = z.object({
  id: z.number().int(),
  file: repositoryFileSchema,
  path: z.string().max(4096),
});

self.onmessage = (event: MessageEvent<unknown>) => {
  const { id, file, path } = requestSchema.parse(event.data);
  if (file.kind === "text") {
    const result = prepareFileRows(file);
    try {
      highlightFileRows(result, path);
    } catch {}
    self.postMessage({ id, result });
  }
};
