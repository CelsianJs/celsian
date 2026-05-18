// @celsian/platform — AWS Lambda deployment provider

import { execSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PlatformError } from "../errors.js";

export interface LambdaDeployOptions {
  /** Working directory (default: process.cwd()) */
  cwd?: string;
  /** AWS region (default: us-east-1) */
  region?: string;
  /** CloudFormation stack name (default: celsian-api) */
  stackName?: string;
}

const TEMPLATE_YAML = `AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Description: CelsianJS API deployed via AWS SAM

Globals:
  Function:
    Runtime: nodejs20.x
    MemorySize: 256
    Timeout: 30

Resources:
  ApiFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: dist/lambda.handler
      CodeUri: .
      Events:
        CatchAll:
          Type: HttpApi
          Properties:
            Path: /{proxy+}
            Method: ANY
        Root:
          Type: HttpApi
          Properties:
            Path: /
            Method: ANY

Outputs:
  ApiUrl:
    Description: API Gateway URL
    Value: !Sub "https://\${ServerlessHttpApi}.execute-api.\${AWS::Region}.amazonaws.com"
`;

/**
 * Deploy a CelsianJS app to AWS Lambda via SAM.
 *
 * 1. Generates template.yaml (SAM template) if not present
 * 2. Builds the app
 * 3. Runs `sam build && sam deploy --guided` or `sam deploy`
 */
export async function deployLambda(opts: LambdaDeployOptions = {}): Promise<{ apiUrl: string }> {
  const cwd = opts.cwd ?? process.cwd();
  const region = opts.region ?? "us-east-1";
  const stackName = opts.stackName ?? "celsian-api";

  // Check if SAM CLI is available
  try {
    execSync("sam --version", { cwd, stdio: "pipe" });
  } catch {
    throw new PlatformError(
      "AWS SAM CLI not found. Install it from: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html",
    );
  }

  // Generate template.yaml if not present
  const templatePath = resolve(cwd, "template.yaml");
  if (!existsSync(templatePath)) {
    writeFileSync(templatePath, TEMPLATE_YAML, "utf-8");
    console.log("[celsian:deploy] Generated template.yaml");
  }

  // Build the app
  console.log("[celsian:deploy] Building app...");
  try {
    execSync("npx celsian build", { cwd, stdio: "inherit" });
  } catch {
    throw new PlatformError("Build failed. Fix build errors and try again.");
  }

  // Build SAM
  console.log("[celsian:deploy] Building SAM package...");
  try {
    execSync("sam build", { cwd, stdio: "inherit" });
  } catch {
    throw new PlatformError("SAM build failed. Check template.yaml and try again.");
  }

  // Deploy via SAM
  console.log("[celsian:deploy] Deploying to AWS Lambda...");
  try {
    const samconfigPath = resolve(cwd, "samconfig.toml");
    const isFirstDeploy = !existsSync(samconfigPath);

    if (isFirstDeploy) {
      // First deploy — use guided mode
      execSync(
        `sam deploy --guided --stack-name ${stackName} --region ${region} --capabilities CAPABILITY_IAM`,
        { cwd, stdio: "inherit" },
      );
    } else {
      execSync("sam deploy", { cwd, stdio: "inherit" });
    }

    // Try to get the API URL from stack outputs
    try {
      const output = execSync(
        `aws cloudformation describe-stacks --stack-name ${stackName} --region ${region} --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text`,
        { cwd, encoding: "utf-8", stdio: "pipe" },
      );
      const apiUrl = output.trim();
      if (apiUrl && apiUrl !== "None") {
        console.log(`[celsian:deploy] Deployed to ${apiUrl}`);
        return { apiUrl };
      }
    } catch {
      // Couldn't fetch stack outputs
    }

    return { apiUrl: `https://<api-id>.execute-api.${region}.amazonaws.com` };
  } catch (error) {
    throw new PlatformError(
      `Lambda deployment failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
