---
title: "An environment of your own."
seoTitle: "An open-source design tool for local projects"
description: "How Tidy combines an open-source design tool, local projects and your choice of coding agent in one workspace for building interfaces."
date: "2026-10-29"
category: "Open source"
artwork: "cloud-coral"
---

An open-source design tool gives you a way to inspect the software you use to make things. A local project gives you a familiar place for your code. Choosing your own coding agent lets you work with the tools you already use. Tidy brings those choices into the same workspace.

The idea is straightforward: your canvas and your implementation should be close enough that moving between them feels like continuing the same piece of work.

## Start with a local project

The Tidy desktop app opens a project directory on your machine. You can work with local designs without a Tidy cloud account or a database. Your design materials and coding threads stay together in that project workflow.

Coding threads have their own prerequisites: a supported agent CLI must be installed and signed in on your machine. Tidy uses that connection. It does not replace the agent provider’s account, permissions or usage terms.

Local project storage also does not mean every agent runs offline. An agent can send context to its model provider as part of a coding task. Choose its permissions and provider settings to suit the project you are working on.

## Keep the choice of agent

Different tasks call for different working styles. You might want an agent to explore several layouts, implement a specific screen or inspect an existing component before proposing changes.

In Tidy, a coding thread has an agent, model and permission settings. You can follow its activity, respond to approval requests and queue a follow-up while it works. The [desktop guide](https://github.com/tidydesigns/tidy/blob/main/apps/desktop/README.md) documents supported agents and setup.

A useful first task is deliberately small: attach one design and ask the agent to implement it using the patterns already in the repository. That gives you a concrete result to review before expanding the scope.

## Share selected designs when you need to

Local work and collaboration have different needs. Sometimes you want to explore privately; sometimes you want another person to work on the same design.

Tidy’s browser app provides a shared design workspace. In the desktop app, signing in lets you connect selected designs to a cloud workspace. Signing in does not upload your repository or local coding threads. The design files you choose to connect can sync with the workspace.

That separation lets you decide what needs to be shared. See the [privacy policy](/privacy) for how the hosted service handles data.

## Read the source, follow the work

Tidy is available under the Apache License 2.0. The [repository](https://github.com/tidydesigns/tidy) contains the app source, development instructions and contribution guidance. Bundled assets have their own notices, linked from the repository.

You can use the source to understand how a feature works, report an issue with specific context, or contribute a change. The [changelog](/changelog) is the place to follow released features and fixes.

We’re building Tidy to keep design decisions close to implementation, with room for people to choose their own tools. [Meet the founders](/about), or try a [design-to-code workflow](/blog/design-to-code-workflow) with a screen from your own project.
