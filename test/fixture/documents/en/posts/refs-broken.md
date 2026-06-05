---
layout: refs-demo
lang: en
href: /blog/refs-broken
title: Post with a broken reference
date: 2026-06-04
$author: /authors/does-not-exist
---

This post references an author entity that does not exist. The schemas
plugin surfaces a warning at validation time; per ADR-0007 A6 it does
NOT fail the build. The next cycle re-evaluates the reference — if the
target appears, the warning clears automatically.
