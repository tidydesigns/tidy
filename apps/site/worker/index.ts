import { createDownloadHandler, type DownloadEnvironment } from "./download";
import { proxyAnalytics, type AnalyticsEnvironment } from "./analytics";

type Environment = DownloadEnvironment &
  AnalyticsEnvironment & { ASSETS: { fetch(request: Request): Promise<Response> } };
const download = createDownloadHandler();

const worker = {
  fetch(request: Request, env: Environment): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/api/privacy/consent" || path.startsWith("/api/t/"))
      return proxyAnalytics(request, env);
    if (path === "/download/mac" || path === "/download/mac/") return download(request, env);
    return env.ASSETS.fetch(request);
  },
};
export default worker;
