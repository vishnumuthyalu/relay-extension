# Sequence diagram

Matches the contracts in `spec/openapi.yaml` and `spec/webhook-contract.md`
(Part 2): same five system actors — GitHub, the relay backend, Claude,
Resend, and the client — in the same order of operations. `Dev` is shown
only as the trigger that kicks the flow off; it isn't one of the five
contracted actors.

```mermaid
sequenceDiagram
    participant Dev
    participant GitHub
    participant Relay as Relay Backend
    participant Claude
    participant Resend
    participant Client

    Dev->>GitHub: git push
    GitHub->>Relay: POST /webhook/github (HMAC-signed)
    Relay->>Relay: verify signature, check X-GitHub-Delivery
    alt already processed
        Relay-->>GitHub: 200 duplicate
    else new delivery
        Relay->>Claude: summarize commits (JSON Schema contract)
        Claude-->>Relay: validated summary
        Relay->>Resend: send digest email
        Resend-->>Client: digest email
        Relay-->>GitHub: 200 processed
    end
```
