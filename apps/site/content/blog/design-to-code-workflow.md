---
title: "Design first. Keep building."
seoTitle: "A practical design-to-code workflow"
description: "A practical design-to-code workflow: shape an interface on the canvas, give your coding agent clear context, and review the working result."
date: "2026-10-29"
category: "Design to code"
artwork: "cloud-spectrum"
---

A design-to-code workflow connects the decisions made on a canvas to the interface people actually use. The useful part is keeping those decisions visible: which content matters, how the layout responds, and what happens when someone interacts with it.

Tidy brings an editable design canvas and coding threads into the same desktop workspace. Here is a small workflow you can try with one screen in an existing project.

## Start with a real task

Choose a screen with a clear purpose, such as a project list. Write down what someone needs to do there: find a project, open it, or create one. Those tasks give you a way to judge the design before you get caught up in styling.

On the canvas, arrange the content around that task. Decide which information needs to be visible at a glance and which details can wait. Use text, frames and auto layout to make the hierarchy explicit. A coding agent can work from a design, but it still needs you to decide what the interface should accomplish.

## Work out the states, not just the happy path

A polished screen with three neatly named projects does not explain what happens with a long title, an empty list or a failed request. Add those cases to your design or describe them alongside it.

For a project list, a useful review checklist is:

- Can someone open a project without waiting for unrelated content?
- Does the layout still work with a long project name?
- Is the primary action reachable on a narrow screen?
- Can a keyboard user reach every control and see the current focus?
- Does a failed request leave the person with a way to continue?

This makes the implementation request more specific and the final review less subjective.

## Bring the design into the coding thread

Open your project directory in the Tidy desktop app and attach the design to a coding thread. Coding threads use a supported agent CLI installed and signed in on your machine. The [desktop setup guide](https://github.com/tidydesigns/tidy/blob/main/apps/desktop/README.md) covers those prerequisites.

Give the agent a bounded task. For example:

> Implement the attached project list using the existing components. Keep the spacing and type hierarchy. Handle long names, an empty list and keyboard navigation. Show me the working page so I can review it.

Name the constraints that matter in your codebase. Reusing a button component or an existing data-loading pattern is usually more useful than recreating everything visible in the mockup.

## Review the working interface

Open the implemented screen and use it. Resize the window, try realistic content, and navigate with the keyboard. Compare the result with the design, then describe a specific correction in the same thread.

The design remains editable while you build. If testing reveals a better layout, update the canvas and use that decision in the next implementation pass. A shorter feedback loop gives you more opportunities to catch small mismatches before they spread through the product.

Try it with [Tidy for macOS](/download/mac), or explore how [MCP keeps design context available to an agent](/blog/design-context-with-mcp).
