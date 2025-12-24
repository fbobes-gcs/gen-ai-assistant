#!/bin/bash

# Deploy CDK stack
echo "Deploying CDK stack..."
npm install
npm run deploy

# Get outputs
API_URL=$(aws cloudformation describe-stacks --stack-name BedrockAssistantStack --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text)
BUCKET_NAME=$(aws cloudformation describe-stacks --stack-name BedrockAssistantStack --query 'Stacks[0].Outputs[?OutputKey==`BucketName`].OutputValue' --output text)
CLOUDFRONT_URL=$(aws cloudformation describe-stacks --stack-name BedrockAssistantStack --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontUrl`].OutputValue' --output text)

# Update frontend with API URL
sed -i "s|YOUR_API_URL_HERE|$API_URL|g" frontend/index.html

# Upload frontend to S3
aws s3 cp frontend/index.html s3://$BUCKET_NAME/

echo "Deployment complete!"
echo "Frontend URL: $CLOUDFRONT_URL"
echo "API URL: $API_URL"
