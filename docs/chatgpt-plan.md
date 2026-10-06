# Use a ChatGPT plan for agent turns

This connection uses OpenAI's open-source Sign in with ChatGPT flow. It authorizes
ChatGPT plan usage separately from your Cloudflare OS login. Eligible accounts and
available models are determined by OpenAI. No OpenAI API key is required.

## Connect

1. On the computer where you will sign in, install Node.js 24 or newer and pnpm.
2. Clone this repository and install its dependencies:

   ```sh
   git clone --branch feat/chatgpt-plan-auth https://github.com/y-128/cloudflare-os.git
   cd cloudflare-os
   pnpm install --frozen-lockfile
   ```

3. Open **AI Providers** in your Cloudflare OS deployment and choose **Continue with ChatGPT**.
4. Copy the generated connection command and run it from the repository directory
   on your computer. The command is a private, single-use capability that expires
   five minutes after creation; it contains no ChatGPT token or Cloudflare OS login token.
5. Open the OpenAI URL printed by the helper in a browser on that same computer.
   Sign in and allow ChatGPT plan usage. The callback listener binds only to
   `127.0.0.1`; do not run the helper on a remote machine with no local browser.
6. When the helper reports success, return to **AI Providers**, choose **Refresh status**,
   and select a model marked **(ChatGPT)** from a workspace's model picker.

The command remains visible if your browser blocks clipboard access. Generate a
new command if an attempt expires or fails. In local development, the frontend
proxies the handoff endpoint to the backend; HTTP is accepted only for a
`localhost` or `127.0.0.1` deployment origin. Production handoffs require HTTPS.
For a Cloudflare Access-protected deployment, the helper must also be able to reach
`POST /api/chatgpt-plan/handoff`: configure that exact path to bypass the browser
Access challenge. The endpoint independently requires both random handoff secrets
and a signed, nonce-bound OpenAI identity. Do not bypass Access for other API paths.

## Billing and model selection

ChatGPT models have distinct internal IDs (`chatgpt:<slug>`). Selecting one routes
agent requests directly to `POST https://api.openai.com/v1/responses`, with
`store: false` and `stream: true`. Tokens never pass through Cloudflare AI Gateway.
An unavailable, expired, or revoked connection stops the turn; it does not switch
to paid API-key or gateway billing. The platform's free-tier turn quota does not
apply to these independently billed turns.

The selected model belongs to the user who starts the turn, including collaborator
turns and their callbacks. The workspace owner's ChatGPT credentials are not used
for another user's model. Scheduled/external messages use the account already
selected by the existing workspace execution policy.

The account-specific model catalog is loaded when connecting and updated with
**Refresh status**. Disconnect removes those models from the picker. Quick tasks
such as automatic titles and gadget language-model bindings continue to use their
existing configuration; ChatGPT plan models cannot be selected as quick models.

Use **Manage usage in ChatGPT** to review limits and app access. Model and usage
availability may change; a displayed model can still be rejected by OpenAI at
request time. Such errors stop inference through the existing agent error path.

## Credential lifecycle

The helper validates the ID token signature, issuer, issued client ID, expiration,
nonce, and the returning account's identity before uploading. The backend repeats
identity verification against the pending authenticated handoff. The issued client
ID and stable host identifier are retained for reconnection to the same account.
Dynamic registration is never used as a token-exchange client ID.

The helper keeps credentials only in memory. The hosted instance stores tokens in
the user's Durable Object, outside the browser RPC surface. Access and rotating
refresh tokens are replaced together, with concurrent refresh calls serialized.
Temporary network failures preserve the connection; terminal refresh failures
clear unusable credentials and require reconnection.

**Disconnect** immediately clears local tokens, pending handoffs, and model choices,
then attempts remote session revocation. If revocation cannot be confirmed, the UI
asks you to remove the app in ChatGPT Settings. In-progress network requests may
finish, but cannot restore a disconnected account's credentials.

## Validation

Automated tests cover the loopback OAuth round trip with signed fixture tokens,
PKCE, callback replay, state/nonce/client/account mismatches, declined consent,
missing scopes, expiry, handoff replay, refresh races, model discovery, and direct
inference routing. No real account tokens are used in tests.

Before deploying, run `pnpm lint` and the relevant backend/frontend/script tests.
The backend `wrangler.jsonc` includes the `v4` SQLite Durable Object migration for
`ChatGptPlanHandoffDirectory`. Generate worker types and release manifests using
the repository's normal tooling; do not add a separate service binding for the
loopback helper.

A live acceptance check requires an interactive eligible ChatGPT account and a
running deployment: connect, pick a discovered model, complete an agent turn,
refresh an expired access token, disconnect, and confirm no new ChatGPT turn starts.
Do not publish credentials, callback URLs, or generated handoff commands as evidence.

## Protocol references

- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
