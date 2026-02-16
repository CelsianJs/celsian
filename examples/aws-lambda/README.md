# CelsianJS AWS Lambda Example

Deploy a CelsianJS API to AWS Lambda behind API Gateway v2 (HTTP API) using AWS SAM.

## Prerequisites

- [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html) configured with credentials
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- Node.js 20+
- pnpm

## Project Structure

```
examples/aws-lambda/
  src/handler.ts     # Lambda entry point with routes
  build.mjs          # esbuild bundler script
  template.yaml      # SAM/CloudFormation template
  samconfig.toml     # Deployment defaults per stage
  package.json
  tsconfig.json
```

## Setup

From the monorepo root:

```bash
pnpm install
```

## Local Development

Start a local API Gateway emulator with SAM:

```bash
# Build first
cd examples/aws-lambda
pnpm build

# Start local API
sam local start-api --warm-containers EAGER
# API available at http://127.0.0.1:3000
```

Test the endpoints:

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/users
curl http://127.0.0.1:3000/users/1
curl -X POST http://127.0.0.1:3000/users \
  -H 'Content-Type: application/json' \
  -d '{"name":"Dave","email":"dave@example.com"}'
curl -X POST http://127.0.0.1:3000/echo \
  -H 'Content-Type: application/json' \
  -d '{"message":"hello"}'
```

## Deploy

### First deploy (guided)

```bash
pnpm build
sam deploy --guided
```

SAM will prompt for stack name, region, and other parameters. Answers are saved to `samconfig.toml` for subsequent deploys.

### Subsequent deploys

```bash
pnpm deploy
```

### Deploy to a specific stage

```bash
# Staging
pnpm build && sam deploy --config-env staging

# Production
pnpm build && sam deploy --config-env prod
```

## Build Details

The `build.mjs` script uses esbuild to:

- Bundle all application code and dependencies into a single `dist/index.mjs`
- Target Node.js 20 with ESM output
- Tree-shake unused code and minify for minimal cold start times
- Externalize `node:*` built-in modules (available in Lambda runtime)
- Generate source maps for debugging in CloudWatch

The Lambda handler file is set to `index.handler` in `template.yaml`, which maps to the named `handler` export in `dist/index.mjs`.

## Infrastructure

The SAM template provisions:

- **AWS::Serverless::HttpApi** — API Gateway v2 HTTP API with CORS enabled
- **AWS::Serverless::Function** — Lambda function (arm64, 256MB, 30s timeout)
- **AWS::Logs::LogGroup** — CloudWatch log group with 14-day retention

### Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `Stage`   | `dev`   | Deployment stage (dev, staging, prod) |

## Monitoring

View logs in real time:

```bash
sam logs --name CelsianFunction --tail
```

## Cleanup

Remove all deployed resources:

```bash
sam delete --stack-name celsian-api
```
