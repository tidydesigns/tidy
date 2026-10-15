import { GET, POST } from "../../app/api/t/[...path]/route";

const worker = {
  fetch(request: Request) {
    const path = new URL(request.url).pathname.replace("/api/t/", "").split("/");
    return (request.method === "GET" ? GET : POST)(request, {
      params: Promise.resolve({ path }),
    });
  },
};

export default worker;
