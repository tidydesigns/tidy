import { useState } from "react";
import { createRoot } from "react-dom/client";
import { nodeStyle } from "../../lib/design/node-style";
import { NodeStrokes } from "../../components/design/node-strokes";
import { buildDrawnNode, type DesignNode } from "../../lib/design/document";
const node: DesignNode = {
  ...buildDrawnNode("measured", "container", "parent", { x: 0, y: 0, width: 100, height: 100 }),
  widthMode: "fill",
  style: { borderWidth: 10, strokePosition: "outside", borderColor: "#ff0000", fill: "#0000ff" },
};
const tokens = {};
function Fixture() {
  const [width, setWidth] = useState(100);
  return (
    <>
      <button onClick={() => setWidth(200)}>Resize</button>
      <div style={{ position: "absolute", left: 50, top: 50, width, height: 100 }}>
        <div id="measured" style={nodeStyle(node, "absolute", tokens)}>
          <NodeStrokes node={node} tokens={tokens} />
        </div>
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
