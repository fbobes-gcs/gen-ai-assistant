# Bedrock Assistant - Serverless AI Chat Application

A secure, serverless AI chat application built with AWS CDK, featuring multiple AI models, conversation memory, and visual chart/diagram generation capabilities.

## Features

- 🤖 **Multiple AI Models**: Support for Claude, Nova, and Llama models via Amazon Bedrock
- 🔐 **Secure Authentication**: Amazon Cognito with email-based registration and restricted access
- 💬 **Conversation Memory**: Persistent chat history with DynamoDB
- 📊 **Visual Generation**: Chart.js and Mermaid.js integration for data visualization
- 🎨 **Model Switching**: Rewrite responses with different AI models
- 🔒 **Security Best Practices**: AWS Secrets Manager, input validation, CORS restrictions
- ☁️ **Serverless Architecture**: Lambda functions, API Gateway, CloudFront distribution

## Architecture

- **Frontend**: Static HTML/CSS/JS hosted on S3 + CloudFront
- **Backend**: AWS Lambda functions with API Gateway
- **Authentication**: Amazon Cognito User Pool
- **Database**: DynamoDB for conversation storage
- **AI Models**: Amazon Bedrock integration
- **Security**: AWS Secrets Manager for configuration

## Prerequisites

- AWS CLI configured with appropriate permissions
- Node.js 18+ and npm
- AWS CDK CLI installed (`npm install -g aws-cdk`)
- Access to Amazon Bedrock models in your AWS account

## Deployment Instructions

### 1. Clone and Install Dependencies

```bash
git clone <your-repo-url>
cd gen-ai-assistant
npm install
```

### 2. Configure Allowed Users

Update the allowed email addresses in `lib/bedrock-assistant-stack.ts`:

```typescript
secretObjectValue: {
  emails: cdk.SecretValue.unsafePlainText(JSON.stringify([
    'your-email@example.com',
    'another-user@example.com'
  ]))
}
```

### 3. Deploy the CDK Stack

```bash
npx cdk bootstrap  # Only needed once per account/region
npx cdk deploy
```

### 4. Update Frontend Configuration

After deployment, update the frontend with your specific URLs:

1. Note the CloudFront URL from the deployment output
2. Update `lib/bedrock-assistant-stack.ts` with your CloudFront domain:
   - Replace `YOUR_CLOUDFRONT_DOMAIN.cloudfront.net` with your actual domain
3. Update `frontend/index.html` with your API Gateway URL:
   - Replace `YOUR_API_GATEWAY_URL` with the actual API Gateway URL from deployment output

### 5. Redeploy with Updated Configuration

```bash
npx cdk deploy
```

### 6. Upload Frontend

```bash
# Replace BUCKET_NAME with your actual S3 bucket name from deployment output
aws s3 cp frontend/index.html s3://BUCKET_NAME/

# Invalidate CloudFront cache
aws cloudfront create-invalidation --distribution-id YOUR_DISTRIBUTION_ID --paths "/*"
```

## Usage

1. Navigate to your CloudFront URL
2. Sign up with one of the allowed email addresses
3. Verify your email and set a password
4. Start chatting with AI models!

### Visual Features

- **Charts**: Use keywords like "chart", "graph", or "plot" to generate Chart.js visualizations
- **Diagrams**: Use keywords like "diagram", "flowchart", or "visualization" to generate Mermaid diagrams

## Security Features

- ✅ **Secrets Management**: Sensitive configuration stored in AWS Secrets Manager
- ✅ **Input Validation**: Comprehensive validation on all API endpoints
- ✅ **CORS Restrictions**: Limited to specific CloudFront domain
- ✅ **Encryption**: DynamoDB and S3 encryption enabled
- ✅ **Security Headers**: CloudFront security headers configured
- ✅ **Access Controls**: Restricted user registration and model access

## Cost Optimization

- **DynamoDB**: Pay-per-request billing
- **Lambda**: Pay-per-invocation with optimized memory settings
- **S3**: Standard storage with lifecycle policies
- **CloudFront**: Global CDN with caching
- **Bedrock**: Pay-per-token usage

## Cleanup

To avoid ongoing charges, destroy the stack when no longer needed:

```bash
npx cdk destroy
```

## Troubleshooting

### Common Issues

1. **"Model not allowed" error**: Ensure the model IDs in the frontend match those in the Lambda function's `ALLOWED_MODELS` array
2. **CORS errors**: Verify the CloudFront domain is correctly configured in all Lambda functions
3. **Authentication issues**: Check that your email is in the allowed list in Secrets Manager

### Logs

Check CloudWatch Logs for detailed error information:
- Lambda function logs: `/aws/lambda/BedrockAssistantStack-*`
- API Gateway logs: Available in CloudWatch if enabled

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

For issues and questions, please open a GitHub issue with:
- Detailed description of the problem
- Steps to reproduce
- CloudWatch logs (with sensitive information redacted)
- AWS region and CDK version
