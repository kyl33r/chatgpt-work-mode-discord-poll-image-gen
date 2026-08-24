---
status: accepted
---

# Use browser-mediated Discord access for the POC

Operate Discord through ChatGPT Work's manually authenticated browser and structured visible-DOM extraction instead of a Discord bot, user token, webhook, or internal API. This minimizes infrastructure and tests the Work-native concept directly, while accepting bounded polling latency and UI fragility; ambiguous browser state must fail closed and never trigger automatic generation or upload retries.
