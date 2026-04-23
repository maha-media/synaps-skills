---
name: security-review
description: Security-focused code review checklist
---

# Security Review

Use this skill to perform a focused security review of code changes. It provides a concise checklist for identifying common security issues such as unsafe input handling, secret exposure, access control gaps, and denial-of-service risks.
When reviewing code for security:

- Check all user input is validated before use
- Look for command injection in shell/exec calls — are inputs escaped?
- Check for path traversal — are file paths resolved and sandboxed?
- Verify auth tokens are not logged or exposed in error messages
- Check for hardcoded secrets, API keys, or credentials
- Ensure HTTPS is used for all external API calls
- Look for TOCTOU (time-of-check-time-of-use) races in file operations
- Check that error messages don't leak internal paths or stack traces
- Verify permissions are checked before destructive operations
- Look for unbounded allocations (DoS via large input)
- Check that crypto uses constant-time comparison for secrets
- Ensure temp files are cleaned up on all code paths (including errors)
