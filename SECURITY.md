# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | Yes                |
| < 0.2   | No                 |

## Reporting a Vulnerability

If you discover a security vulnerability in CelsianJS, please report it responsibly.

**Do not open a public issue.**

Instead, email **security@celsianjs.dev** with:

1. A description of the vulnerability
2. Steps to reproduce (or a proof-of-concept)
3. The affected version(s)
4. Any potential impact assessment

## Response Timeline

| Action                        | Timeframe       |
| ----------------------------- | --------------- |
| Acknowledgement of report     | Within 48 hours |
| Initial assessment            | Within 5 days   |
| Fix development and release   | Within 30 days  |
| Public disclosure (coordinated) | After fix is released |

We will credit reporters in the release notes unless they prefer to remain anonymous.

## Scope

This policy covers all packages in the `@celsian/*` namespace published to npm.

## Security Best Practices for Users

- Keep CelsianJS and its dependencies up to date
- Use the built-in `security()` plugin for HTTP security headers
- Enable CSRF protection for state-changing routes
- Never expose `.env` files or secrets in client bundles
- Use the `cors()` plugin with explicit origin allowlists in production
