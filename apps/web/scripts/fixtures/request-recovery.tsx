import { createRoot } from "react-dom/client";
import { useCallback, useState } from "react";
import { useFileRoom } from "../../app/files/[uid]/use-file-room";
import { blankDesignDocument, buildDrawnNode } from "../../lib/design/document";
import { diffDocument } from "../../lib/design/document-patch";

const content = {
  ...blankDesignDocument(),
  nodes: [buildDrawnNode("a", "container", null, { x: 0, y: 0, width: 100, height: 100 })],
};
const initial = { revision: 1, content };
class TestSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 1;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  constructor() {
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "ready" }) }), 10);
  }
  send() {}
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}
Object.assign(window, { WebSocket: TestSocket, recoveryFixtureDocument: content });
function Room() {
  const [snapshot, setSnapshot] = useState(initial);
  const [result, setResult] = useState("");
  const onName = useCallback(() => {}, []);
  const room = useFileRoom({
    fileId: "fixture",
    enabled: true,
    initialSnapshot: initial,
    onSnapshot: setSnapshot,
    onName,
  });
  return (
    <>
      <output id="connection">{room.connection}</output>
      <output id="revision">{snapshot.revision}</output>
      <output id="name">{snapshot.content.nodes[0]?.name}</output>
      <output id="result">{result}</output>
      <button
        onClick={() => {
          setResult("pending");
          void room
            .commit(
              diffDocument(content, {
                ...content,
                nodes: [{ ...content.nodes[0], name: "Renamed" }],
              }),
            )
            .then(
              () => setResult("committed"),
              () => setResult("rejected"),
            );
        }}
      >
        Edit
      </button>
    </>
  );
}
function Fixture() {
  const [visible, setVisible] = useState(true);
  return (
    <>
      <button onClick={() => setVisible(false)}>Leave</button>
      {visible && <Room />}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
