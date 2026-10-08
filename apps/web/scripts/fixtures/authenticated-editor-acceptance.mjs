import assert from "node:assert/strict";
import sharp from "sharp";

export async function authenticatedEditorAcceptance({
  base,
  fileId,
  organization,
  users,
  contexts,
  a,
  b,
  client,
  proxy,
  snapshot,
  post,
}) {
  const select = (page, name) =>
    page.getByRole("button", { name: `Select ${name}`, exact: true }).click();
  const name = b.getByRole("textbox", { name: "Layer name", exact: true });
  const openPanels = async (page) => {
    await page.getByRole("button", { name: /^(Expand|Minimize) editor panels$/ }).waitFor();
    const button = page.getByRole("button", { name: "Expand editor panels", exact: true });
    if (await button.isVisible()) await button.click();
    await page.getByRole("button", { name: "Select Frame", exact: true }).click();
  };
  const edit = async (id, path, value, actor = contexts[0]) => {
    const node = (await snapshot()).snapshot.content.nodes.find((node) => node.id === id);
    let before = node;
    for (const key of path) before = before?.[key];
    const response = await post(actor, {
      operationId: crypto.randomUUID(),
      patch: [
        {
          collection: "nodes",
          id,
          path,
          before: before === undefined ? { exists: false } : { exists: true, value: before },
          after: { exists: true, value },
        },
      ],
    });
    assert.equal(response.status(), 200, await response.text());
  };
  const png = await sharp({
    create: { width: 400, height: 200, channels: 4, background: "#38aabb" },
  })
    .png()
    .toBuffer();
  const replacement = await sharp({
    create: { width: 300, height: 300, channels: 4, background: "#ee8844" },
  })
    .png()
    .toBuffer();

  await select(b, "My unfinished layer name");
  const upload = proxy.holdNext(`/api/files/${fileId}/assets`);
  await b
    .locator('input[type="file"]')
    .nth(1)
    .setInputFiles({ name: "acceptance.png", mimeType: "image/png", buffer: png });
  await upload.reached;
  await select(b, "Heading");
  upload.release();
  await b.getByRole("button", { name: "Select acceptance.png", exact: true }).waitFor();
  await a.getByRole("button", { name: "Select acceptance.png", exact: true }).waitFor();
  assert.equal(await name.inputValue(), "Heading", "Completed upload preserves later selection");
  const image = (await snapshot()).snapshot.content.nodes.find(
    (node) => node.name === "acceptance.png",
  );
  assert.ok(image?.assetId);
  const source = await contexts[0].request.get(`${base}/api/assets/${image.assetId}`);
  assert.equal(source.status(), 200);
  assert.deepEqual(await source.body(), png);
  console.log("PASS: real image upload preserves later selection and returns original bytes");

  const crop = { x: 0.2, y: 0.1, width: 0.5, height: 0.6, sourceWidth: 400, sourceHeight: 200 };
  await edit(image.id, ["style"], { ...image.style, objectFit: "cover", imageCrop: crop });
  await select(b, "acceptance.png");
  await b.getByRole("button", { name: "Reset crop", exact: true }).waitFor();
  const replace = proxy.holdNext(`/api/files/${fileId}/assets`);
  await b
    .locator('input[type="file"]')
    .nth(0)
    .setInputFiles({ name: "replacement.png", mimeType: "image/png", buffer: replacement });
  await replace.reached;
  await select(b, "Heading");
  replace.release();
  await a.waitForFunction(
    ({ id, previous }) => {
      const image = document.querySelector(`[data-node-id="${id}"] > img`);
      return image instanceof HTMLImageElement && !image.src.includes(previous);
    },
    { id: image.id, previous: image.assetId },
  );
  assert.equal(await name.inputValue(), "Heading", "Replacement preserves later selection");
  let replaced = (await snapshot()).snapshot.content.nodes.find((node) => node.id === image.id);
  assert.notEqual(replaced.assetId, image.assetId);
  assert.equal(replaced.style.imageCrop, undefined, "Replacement clears old source crop");
  await edit(image.id, ["style"], {
    ...replaced.style,
    imageCrop: {
      ...crop,
      sourceWidth: 300,
      sourceHeight: 300,
    },
  });
  const rectangle = (await snapshot()).snapshot.content.nodes.find(
    (node) => node.id === "rectangle",
  );
  const paints = [
    {
      id: "persisted-image",
      type: "image",
      assetId: replaced.assetId,
      visible: true,
      opacity: 1,
      fit: "cover",
      positionX: 25,
      positionY: 60,
      crop: { ...crop, sourceWidth: 300, sourceHeight: 300 },
    },
  ];
  await edit("rectangle", ["style"], { ...rectangle.style, paints });
  await Promise.all([a.reload(), b.reload()]);
  await Promise.all([openPanels(a), openPanels(b)]);
  await b.locator(`[data-node-id="${image.id}"] svg[data-image-crop]`).waitFor();
  const reopened = (await snapshot()).snapshot.content;
  assert.deepEqual(reopened.nodes.find((node) => node.id === "rectangle").style.paints, paints);
  assert.deepEqual(reopened.nodes.find((node) => node.id === image.id).style.imageCrop, {
    ...crop,
    sourceWidth: 300,
    sourceHeight: 300,
  });
  await b
    .locator('[data-node-id="rectangle"] [data-fill-id="persisted-image"] svg[data-image-crop]')
    .waitFor();
  console.log(
    "PASS: real replacement resets source crop; image and paint crops survive both browser reopens",
  );

  await select(b, "My unfinished layer name");
  const ack = proxy.holdNext(`/api/files/${fileId}/changes`);
  await name.fill("Acknowledged rectangle");
  await name.press("Enter");
  await ack.reached;
  await select(b, "Heading");
  ack.release();
  await a.getByRole("button", { name: "Select Acknowledged rectangle", exact: true }).waitFor();
  assert.equal(await name.inputValue(), "Heading");
  console.log("PASS: a delayed real commit acknowledgment preserves the next selection");

  await select(b, "Acknowledged rectangle");
  const reject = proxy.holdNext(`/api/files/${fileId}/changes`, "request");
  await name.fill("Rejected name");
  await name.press("Enter");
  await reject.reached;
  await select(b, "Heading");
  const drift = users.find((user) => user.name === "Drift");
  await client.query(
    'update "member" set "role"=\'viewer\' where "organizationId"=$1 and "userId"=$2',
    [organization, drift.id],
  );
  reject.release();
  await b.getByRole("alert").filter({ hasText: "Editor access is required" }).waitFor();
  assert.equal(await name.inputValue(), "Heading");
  assert.equal(
    (await snapshot()).snapshot.content.nodes.find((node) => node.id === "rectangle").name,
    "Acknowledged rectangle",
  );
  await client.query(
    'update "member" set "role"=\'owner\' where "organizationId"=$1 and "userId"=$2',
    [organization, drift.id],
  );
  console.log(
    "PASS: real permission rejection rolls back the optimistic edit and preserves later selection",
  );

  await Promise.all([a.reload(), b.reload()]);
  await Promise.all([openPanels(a), openPanels(b)]);
  await select(b, "Acknowledged rectangle");
  await name.fill("Local undo candidate");
  await name.press("Enter");
  await a.getByRole("button", { name: "Select Local undo candidate", exact: true }).waitFor();
  await edit("rectangle", ["name"], "Newer collaborator name");
  await b.getByRole("button", { name: "Select Newer collaborator name", exact: true }).waitFor();
  await b.getByLabel("Design canvas", { exact: true }).focus();
  await b.keyboard.press("Control+z");
  await b
    .getByRole("alert")
    .filter({ hasText: "This edit changed elsewhere and cannot be undone." })
    .waitFor();
  assert.equal(
    (await snapshot()).snapshot.content.nodes.find((node) => node.id === "rectangle").name,
    "Newer collaborator name",
  );
  console.log("PASS: browser undo conflict retains the newer collaborator edit");

  const heading = (await snapshot()).snapshot.content.nodes.find((node) => node.id === "text");
  await edit("text", ["style"], {
    ...heading.style,
    fontFamily: "Tidy Missing Font 40",
    fontSource: "local",
  });
  await select(b, "Heading");
  await b.getByText(/Unavailable fonts/).waitFor();
  const rendered = await b.locator('[data-node-id="text"]').boundingBox();
  assert.ok(rendered.width > 0 && rendered.height > 0);
  assert.ok((await b.locator('[data-node-id="text"]').innerText()).includes("Independent edit"));
  await b.reload();
  await openPanels(b);
  await select(b, "Heading");
  await b.getByText(/Unavailable fonts/).waitFor();
  assert.equal(
    (await snapshot()).snapshot.content.nodes.find((node) => node.id === "text").style.fontFamily,
    "Tidy Missing Font 40",
  );
  await edit("text", ["style"], heading.style);
  console.log(
    "PASS: an unavailable local font renders a fallback, reports it and retains its binding after reopen",
  );

  const foreign = `foreign-${fileId}`,
    foreignFile = `file-${foreign}`;
  const echo = users.find((user) => user.name === "Echo");
  try {
    await client.query(
      'insert into "organization" ("id","name","slug","createdAt","createdByUserId") values ($1,$1,$1,now(),$2)',
      [foreign, echo.id],
    );
    await client.query(
      'insert into "member" ("id","organizationId","userId","role","createdAt") values ($1,$2,$3,\'owner\',now())',
      [`member-${foreign}`, foreign, echo.id],
    );
    await client.query(
      'insert into "designFile" ("id","organizationId","name","createdBy") values ($1,$2,\'Foreign file\',$3)',
      [foreignFile, foreign, echo.id],
    );
    const response = await contexts[0].request.post(`${base}/api/files/${foreignFile}/assets`, {
      headers: { Origin: base },
      multipart: { image: { name: "foreign.png", mimeType: "image/png", buffer: png } },
    });
    assert.equal(response.status(), 200, await response.text());
    const foreignAsset = (await response.json()).assetId;
    assert.equal(
      (
        await contexts[1].request.post(`${base}/api/files/${foreignFile}/assets`, {
          headers: { Origin: base },
          multipart: { image: { name: "denied.png", mimeType: "image/png", buffer: png } },
        })
      ).status(),
      404,
    );
    assert.equal(
      (await contexts[1].request.get(`${base}/api/assets/${foreignAsset}`)).status(),
      404,
    );
    const current = (await snapshot()).snapshot.content.nodes.find((node) => node.id === image.id);
    const denied = await post(contexts[0], {
      operationId: crypto.randomUUID(),
      patch: [
        {
          collection: "nodes",
          id: image.id,
          path: ["assetId"],
          before: { exists: true, value: current.assetId },
          after: { exists: true, value: foreignAsset },
        },
      ],
    });
    assert.equal(denied.status(), 409);
    assert.equal((await denied.json()).error, "One or more assets are inaccessible.");
    assert.equal(
      (await snapshot()).snapshot.content.nodes.find((node) => node.id === image.id).assetId,
      current.assetId,
    );
    console.log(
      "PASS: real upload/read deny foreign members; file patches reject foreign assets even for a member of both organizations",
    );
  } finally {
    await client.query('delete from "organization" where "id"=$1', [foreign]);
  }
}
