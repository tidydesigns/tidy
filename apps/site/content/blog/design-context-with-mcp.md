---
title: "From a design file to a coding thread."
seoTitle: "MCP design tools: from canvas to code"
description: "Use Tidy’s MCP design tools to give your agent editable design context, inspect the result and carry visual decisions into implementation."
date: "2026-10-29"
category: "MCP & agents"
artwork: "cloud-spectrum"
---

A screenshot can show an agent what an interface looks like. An editable design file can also expose how it is arranged: text, layers, layout, components and the relationships between them. Both are useful when you want an implementation to preserve the intent of a design.

Tidy exposes design tools through MCP, the Model Context Protocol. A connected agent can read design files and, with editing access, create or revise the canvas. This is a way to bring design context into a conversation where you are already working on code.

## Give the agent a specific reference

Begin with a file and a frame, not an instruction to search through every design in a workspace. Tell the agent which screen matters, what you want to change, and which parts should remain consistent.

For example:

> Read the project list in this Tidy file. Use it as the reference for the project page in this repository. Reuse our existing controls and check the layout at desktop and mobile widths.

The file gives the agent a concrete starting point. The request explains what to do with it. If your design includes screenshots or other images, ask the agent to inspect those too; a layer tree alone does not describe every visual detail.

## Read before making changes

Tidy’s MCP tools can list accessible files and read a document’s current structure. Editing tools work against the current document revision so an agent can identify when the design changed since it was read.

A useful sequence is to read the design, explain the proposed change, apply it and inspect the result. Keep each step focused on the screen you are working on. You can also edit the canvas yourself and ask the agent to continue from that updated design.

The [agent connection guide](https://github.com/tidydesigns/tidy/blob/main/apps/gpt-plugin/README.md) documents Tidy’s connection flow. Available tools and authorization depend on the client and the access you grant.

## Carry visual intent into implementation

When the design is ready to try in code, bring it into a coding thread. In the Tidy desktop app, you can attach a design to a thread working in your local project. Tell the agent to inspect the existing implementation before adding new components.

Be explicit about behavior that a static design cannot fully describe. For example:

- Opening a folder should reveal its contents immediately.
- A long label should wrap without hiding the action next to it.
- A failed update should leave the interface usable.
- Keyboard focus should remain visible through the interaction.

These are acceptance criteria you can actually check. They help connect the appearance of a screen to how it feels to use.

## Close the loop with a visual check

A successful tool call confirms an operation completed; it does not prove the resulting interface looks right. Inspect the canvas after a design change and the running application after a code change.

Compare spacing, type, content and interaction states. If something differs, identify the element and the correction you want. A specific observation such as “the project title wraps under its action on mobile” gives the next pass a useful target.

MCP makes the design available to the agent. A clear task and a visible review make that context useful. For a complete example of the process, read [Design first. Keep building.](/blog/design-to-code-workflow), or [open Tidy](https://app.tidydesign.co/login) to start with a design file.
