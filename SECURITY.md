# Security Policy

## Reporting a Vulnerability

Please report security issues privately by emailing the maintainer or by using
GitHub private vulnerability reporting if it is enabled on the repository.

Do not open a public issue for suspected vulnerabilities involving credentials,
browser storage state, OAuth tokens, generated artifacts, or test lifecycle
endpoints.

## Sensitive Test Data

JourneyTest writes run artifacts for debugging and auditability. Text artifacts
redact common token, cookie, password, and secret patterns, but screenshots and
videos are visual evidence and cannot be text-redacted.

Use dedicated test accounts, short-lived browser state, and non-production data
when running journeys.
