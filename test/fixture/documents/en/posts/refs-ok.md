---
layout: refs-demo
lang: en
href: /blog/refs-ok
title: Post with a resolving reference
date: 2026-06-04
$author: /authors/dick
---

This post references its author via the `$author` key. The schemas plugin
auto-validates the reference; templates see `meta.author` (normalized) and
render the href string. Phase 2 will let consumers ask for the resolved
author entity inline via `expand: ['author']`.
