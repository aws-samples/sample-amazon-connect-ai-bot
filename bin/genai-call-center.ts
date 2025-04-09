#!/usr/bin/env node
import 'source-map-support/register'
import * as cdk from 'aws-cdk-lib'
import { KnowledgeBaseStack } from '../lib/knowledge-base-stack'
import { GenAiCallCenterStack } from '../lib/genai-call-center-stack'

const app = new cdk.App()

new KnowledgeBaseStack(app, 'KnowledgeBase', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-west-2' },
})

new GenAiCallCenterStack(app, 'GenAiCallCenter', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-west-2' },
  knowledgeBaseRegion: 'us-west-2',
  knowledgeBaseId: 'YOUR_KNOWLEDGE_BASE_ID',
})
