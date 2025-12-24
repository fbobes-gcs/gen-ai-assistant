#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as fs from 'fs';
import * as path from 'path';
import { BedrockAssistantStack } from '../lib/bedrock-assistant-stack';

// Load local config if exists (contains sensitive values, gitignored)
const localConfigPath = path.join(__dirname, '..', 'cdk.context.local.json');
let localConfig: Record<string, any> = {};
if (fs.existsSync(localConfigPath)) {
  localConfig = JSON.parse(fs.readFileSync(localConfigPath, 'utf-8'));
}

const app = new cdk.App({
  context: localConfig
});

new BedrockAssistantStack(app, 'BedrockAssistantStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
