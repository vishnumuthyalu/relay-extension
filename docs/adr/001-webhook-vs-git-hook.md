# ADR 001: Use a server-side webhook, not a local git hook

## Status
Accepted

## Context
Client updates need to fire whenever code is pushed, regardless of
which machine did the pushing.

## Decision
Register a GitHub webhook against the repository, delivered to a
hosted backend, rather than a local post-receive/pre-push git hook
on each developer's machine.

## Consequences
A hosted webhook fires identically from any contributor's machine or
CI, and centralizes the HMAC secret in one place instead of
distributing it to every developer's .git/hooks. The cost is an
always-on backend and a public URL GitHub can reach — a local hook
would need neither, but would only fire from machines that had it
installed, which doesn't hold for a team.
