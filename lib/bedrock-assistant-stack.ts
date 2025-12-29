import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

export class BedrockAssistantStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Load configuration from context (set in cdk.json or via --context)
    const allowedEmails = this.node.tryGetContext('allowedEmails') || [];
    const appDomain = this.node.tryGetContext('appDomain') || 'example.com';
    const appSubdomain = this.node.tryGetContext('appSubdomain') || 'app';
    const fullDomain = `${appSubdomain}.${appDomain}`;

    // Create secret for allowed emails
    const allowedEmailsSecret = new secretsmanager.Secret(this, 'AllowedEmails', {
      description: 'Allowed email addresses for registration',
      secretObjectValue: {
        emails: cdk.SecretValue.unsafePlainText(JSON.stringify(allowedEmails))
      }
    });

    // Create secret for CloudFront domain
    const cloudfrontDomainSecret = new secretsmanager.Secret(this, 'CloudFrontDomain', {
      description: 'CloudFront domain for CORS configuration',
      secretStringValue: cdk.SecretValue.unsafePlainText(`https://${fullDomain}`)
    });

    // Create secret for allowed models
    const allowedModelsSecret = new secretsmanager.Secret(this, 'AllowedModels', {
      description: 'Allowed Bedrock model IDs',
      secretObjectValue: {
        models: cdk.SecretValue.unsafePlainText(JSON.stringify([
          'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
          'us.anthropic.claude-haiku-4-5-20251001-v1:0',
          'us.amazon.nova-premier-v1:0',
          'us.amazon.nova-2-lite-v1:0',
          'us.amazon.nova-pro-v1:0',
          'us.meta.llama4-scout-17b-instruct-v1:0',
          'us.meta.llama4-maverick-17b-instruct-v1:0',
          'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
          'amazon.nova-canvas-v1:0',
          'stability.stable-image-ultra-v1:0',
          'stability.stable-image-core-v1:0'
        ]))
      }
    });

    // Create secret for Tavily API key
    const tavilySecret = new secretsmanager.Secret(this, 'TavilyApiKey', {
      description: 'Tavily Search API key for web search functionality',
      secretStringValue: cdk.SecretValue.unsafePlainText('REDACTED_API_KEY')
    });

    // Get existing hosted zone
    const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
      domainName: appDomain
    });

    // Create SSL certificate
    const certificate = new certificatemanager.Certificate(this, 'Certificate', {
      domainName: fullDomain,
      validation: certificatemanager.CertificateValidation.fromDns(hostedZone)
    });

    const conversationsTable = new dynamodb.Table(this, 'Conversations', {
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'conversationId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecovery: true,
      encryption: dynamodb.TableEncryption.AWS_MANAGED
    });

    // S3 bucket for Nova Reel video output
    const videoOutputBucket = new s3.Bucket(this, 'VideoOutputBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{
        expiration: cdk.Duration.days(7)
      }]
    });

    // Pre-signup Lambda to restrict user registration
    const preSignupLambda = new lambda.Function(this, 'PreSignupFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(10),
      code: lambda.Code.fromInline(`
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const secretsClient = new SecretsManagerClient({});

exports.handler = async (event) => {
  try {
    const secretResponse = await secretsClient.send(new GetSecretValueCommand({
      SecretId: process.env.ALLOWED_EMAILS_SECRET
    }));
    
    const secretData = JSON.parse(secretResponse.SecretString);
    const allowedEmails = JSON.parse(secretData.emails);
    const email = event.request.userAttributes.email;
    
    if (!email || !allowedEmails.includes(email.toLowerCase())) {
      throw new Error('Registration not allowed for this email address');
    }
    
    return event;
  } catch (error) {
    console.error('Pre-signup error:', error);
    throw new Error('Registration failed');
  }
};
      `),
      environment: {
        ALLOWED_EMAILS_SECRET: allowedEmailsSecret.secretArn
      }
    });

    // Grant permissions to read the secret
    allowedEmailsSecret.grantRead(preSignupLambda);

    // Cognito User Pool with proper email configuration
    const userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      lambdaTriggers: {
        preSignUp: preSignupLambda
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    const userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool,
      generateSecret: false,
      authFlows: {
        userSrp: true,
        userPassword: true
      }
    });

    // Lambda function for password management
    const passwordLambda = new lambda.Function(this, 'PasswordFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(10),
      code: lambda.Code.fromInline(`
const { CognitoIdentityProviderClient, AdminSetUserPasswordCommand } = require('@aws-sdk/client-cognito-identity-provider');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const cognito = new CognitoIdentityProviderClient({});
const secretsClient = new SecretsManagerClient({});

let cachedDomain = null;

async function getCloudfrontDomain() {
  if (cachedDomain) return cachedDomain;
  
  try {
    const response = await secretsClient.send(new GetSecretValueCommand({
      SecretId: process.env.CLOUDFRONT_DOMAIN_SECRET
    }));
    cachedDomain = response.SecretString;
    return cachedDomain;
  } catch (error) {
    console.warn('Failed to get domain from secrets:', error);
    return 'https://' + process.env.APP_DOMAIN; // Fallback
  }
}

exports.handler = async (event) => {
  const cloudfrontDomain = await getCloudfrontDomain();
  
  const headers = {
    'Access-Control-Allow-Origin': cloudfrontDomain,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST,OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { email, password } = body;
    
    // Input validation
    if (!email || !password) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Email and password are required' })
      };
    }
    
    if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid email format' })
      };
    }
    
    if (password.length < 8) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Password must be at least 8 characters' })
      };
    }
    
    await cognito.send(new AdminSetUserPasswordCommand({
      UserPoolId: process.env.USER_POOL_ID,
      Username: email.toLowerCase(),
      Password: password,
      Permanent: true
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true })
    };
  } catch (error) {
    console.error('Password setting error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Password setup failed' })
    };
  }
};
      `),
      environment: {
        USER_POOL_ID: userPool.userPoolId,
        CLOUDFRONT_DOMAIN_SECRET: cloudfrontDomainSecret.secretArn,
        APP_DOMAIN: fullDomain
      }
    });

    // Configuration Lambda for frontend
    const configLambda = new lambda.Function(this, 'ConfigFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(5),
      code: lambda.Code.fromInline(`
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const secretsClient = new SecretsManagerClient({});
let cachedDomain = null;

async function getCloudfrontDomain() {
  if (cachedDomain) return cachedDomain;
  
  try {
    const response = await secretsClient.send(new GetSecretValueCommand({
      SecretId: process.env.CLOUDFRONT_DOMAIN_SECRET
    }));
    cachedDomain = response.SecretString;
    return cachedDomain;
  } catch (error) {
    console.warn('Failed to get domain from secrets:', error);
    return 'https://' + process.env.APP_DOMAIN; // Fallback
  }
}

exports.handler = async (event) => {
  const cloudfrontDomain = await getCloudfrontDomain();
  
  const headers = {
    'Access-Control-Allow-Origin': cloudfrontDomain,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Cache-Control': 'public, max-age=300'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      userPoolId: process.env.USER_POOL_ID,
      userPoolWebClientId: process.env.USER_POOL_CLIENT_ID,
      region: process.env.AWS_REGION
    })
  };
};
      `),
      environment: {
        USER_POOL_ID: userPool.userPoolId,
        USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
        CLOUDFRONT_DOMAIN_SECRET: cloudfrontDomainSecret.secretArn,
        APP_DOMAIN: fullDomain
      }
    });

    // Grant admin permissions to the password Lambda
    passwordLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['cognito-idp:AdminSetUserPassword'],
      resources: [userPool.userPoolArn]
    }));

    // Grant secrets access to Lambda functions
    cloudfrontDomainSecret.grantRead(passwordLambda);
    cloudfrontDomainSecret.grantRead(configLambda);

    // Lambda function for Bedrock API with enhanced security
    const bedrockLambda = new lambda.Function(this, 'BedrockFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      code: lambda.Code.fromInline(`
const { BedrockRuntimeClient, InvokeModelCommand, ConverseCommand, StartAsyncInvokeCommand, GetAsyncInvokeCommand } = require('@aws-sdk/client-bedrock-runtime');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const bedrock = new BedrockRuntimeClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secretsClient = new SecretsManagerClient({});
const s3Client = new S3Client({});

let cachedModels = null;
let cachedDomain = null;
let cachedTavilyKey = null;
let lastCacheTime = 0;

async function getAllowedModels() {
  const now = Date.now();
  if (cachedModels && (now - lastCacheTime) < 300000) return cachedModels; // 5 min cache
  
  try {
    const response = await secretsClient.send(new GetSecretValueCommand({
      SecretId: process.env.ALLOWED_MODELS_SECRET
    }));
    const secretData = JSON.parse(response.SecretString);
    cachedModels = secretData.models; // Already an array, no need to parse again
    lastCacheTime = now;
    return cachedModels;
  } catch (error) {
    console.warn('Failed to get models from secrets:', error);
    // Fallback models
    return [
      'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      'us.amazon.nova-premier-v1:0',
      'us.amazon.nova-2-lite-v1:0',
      'us.amazon.nova-pro-v1:0',
      'us.meta.llama4-scout-17b-instruct-v1:0',
      'us.meta.llama4-maverick-17b-instruct-v1:0',
      'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
      'amazon.nova-canvas-v1:0',
      'amazon.nova-reel-v1:0'
    ];
  }
}

async function getTavilyApiKey() {
  if (cachedTavilyKey) return cachedTavilyKey;
  
  try {
    const response = await secretsClient.send(new GetSecretValueCommand({
      SecretId: process.env.TAVILY_API_SECRET
    }));
    cachedTavilyKey = response.SecretString;
    return cachedTavilyKey;
  } catch (error) {
    console.warn('Failed to get Tavily API key from secrets:', error);
    return null;
  }
}

async function performWebSearch(query, tavilyApiKey) {
  if (!tavilyApiKey) return null;
  
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        api_key: tavilyApiKey,
        query: query,
        search_depth: 'basic',
        include_answer: true,
        include_raw_content: false,
        max_results: 5
      })
    });
    
    if (!response.ok) {
      console.error('Tavily API error:', response.status, response.statusText);
      return null;
    }
    
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Web search error:', error);
    return null;
  }
}

async function getStockData(symbol) {
  try {
    // Get basic stock info
    const quoteResponse = await fetch(\`https://query1.finance.yahoo.com/v8/finance/chart/\${symbol}\`);
    if (!quoteResponse.ok) return null;
    
    const quoteData = await quoteResponse.json();
    const result = quoteData.chart.result[0];
    const meta = result.meta;
    const quote = result.indicators.quote[0];
    
    // Get additional company info
    const summaryResponse = await fetch(\`https://query2.finance.yahoo.com/v10/finance/quoteSummary/\${symbol}?modules=summaryDetail,financialData,defaultKeyStatistics\`);
    let summaryData = null;
    if (summaryResponse.ok) {
      summaryData = await summaryResponse.json();
    }
    
    const currentPrice = meta.regularMarketPrice;
    const previousClose = meta.previousClose;
    const change = currentPrice - previousClose;
    const changePercent = (change / previousClose) * 100;
    
    // Get market time and convert to readable date
    const marketTime = new Date(meta.regularMarketTime * 1000);
    const marketDate = marketTime.toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'short', 
      day: 'numeric',
      timeZone: meta.exchangeTimezoneName || 'America/New_York'
    });
    
    // Determine asset type
    let assetType = 'Stock';
    if (symbol.includes('-USD')) assetType = 'Cryptocurrency';
    else if (symbol.includes('=X')) assetType = 'Forex';
    else if (symbol.includes('=F')) assetType = 'Commodity';
    else if (symbol.startsWith('^')) assetType = 'Index';
    else if (['SPY', 'QQQ', 'VTI', 'VOO', 'IEF', 'GLD', 'SLV'].includes(symbol)) assetType = 'ETF';
    
    return {
      symbol: meta.symbol,
      assetType: assetType,
      companyName: meta.longName || meta.shortName,
      currentPrice: currentPrice,
      previousClose: previousClose,
      change: change,
      changePercent: changePercent,
      currency: meta.currency,
      marketDate: marketDate,
      marketCap: summaryData?.quoteSummary?.result?.[0]?.summaryDetail?.marketCap?.raw,
      peRatio: summaryData?.quoteSummary?.result?.[0]?.summaryDetail?.trailingPE?.raw,
      volume: meta.regularMarketVolume,
      dayHigh: meta.regularMarketDayHigh,
      dayLow: meta.regularMarketDayLow,
      fiftyTwoWeekHigh: summaryData?.quoteSummary?.result?.[0]?.summaryDetail?.fiftyTwoWeekHigh?.raw,
      fiftyTwoWeekLow: summaryData?.quoteSummary?.result?.[0]?.summaryDetail?.fiftyTwoWeekLow?.raw
    };
  } catch (error) {
    console.error('Financial data error:', error);
    return null;
  }
}

function detectStockSymbols(prompt) {
  // Common stock symbol patterns
  const symbolPatterns = [
    /\\b([A-Z]{1,5})\\s+stock/gi,
    /\\$([A-Z]{1,5})\\b/g,
    /\\b(AAPL|MSFT|GOOGL|AMZN|TSLA|META|NVDA|AMD|INTC|CRM|NFLX|DIS|BA|JPM|BAC|WMT|JNJ|PG|KO|PEP|V|MA|PYPL)\\b/gi
  ];
  
  // Company name to symbol mapping
  const companyMap = {
    'apple': 'AAPL',
    'microsoft': 'MSFT', 
    'google': 'GOOGL',
    'alphabet': 'GOOGL',
    'amazon': 'AMZN',
    'tesla': 'TSLA',
    'meta': 'META',
    'facebook': 'META',
    'nvidia': 'NVDA',
    'amd': 'AMD',
    'intel': 'INTC',
    'salesforce': 'CRM',
    'netflix': 'NFLX',
    'disney': 'DIS',
    'boeing': 'BA',
    'jpmorgan': 'JPM',
    'bank of america': 'BAC',
    'walmart': 'WMT',
    'johnson': 'JNJ',
    'procter': 'PG',
    'coca cola': 'KO',
    'pepsi': 'PEP',
    'visa': 'V',
    'mastercard': 'MA',
    'paypal': 'PYPL'
  };
  
  // Cryptocurrency mapping
  const cryptoMap = {
    'bitcoin': 'BTC-USD',
    'btc': 'BTC-USD',
    'ethereum': 'ETH-USD',
    'eth': 'ETH-USD',
    'dogecoin': 'DOGE-USD',
    'doge': 'DOGE-USD',
    'cardano': 'ADA-USD',
    'ada': 'ADA-USD',
    'solana': 'SOL-USD',
    'sol': 'SOL-USD',
    'polkadot': 'DOT-USD',
    'dot': 'DOT-USD',
    'chainlink': 'LINK-USD',
    'link': 'LINK-USD',
    'litecoin': 'LTC-USD',
    'ltc': 'LTC-USD',
    'ripple': 'XRP-USD',
    'xrp': 'XRP-USD'
  };
  
  // Forex pairs mapping
  const forexMap = {
    'eurusd': 'EURUSD=X',
    'eur/usd': 'EURUSD=X',
    'gbpusd': 'GBPUSD=X',
    'gbp/usd': 'GBPUSD=X',
    'usdjpy': 'USDJPY=X',
    'usd/jpy': 'USDJPY=X',
    'usdcad': 'USDCAD=X',
    'usd/cad': 'USDCAD=X',
    'audusd': 'AUDUSD=X',
    'aud/usd': 'AUDUSD=X'
  };
  
  // ETFs and Indices mapping
  const etfIndexMap = {
    'spy': 'SPY',
    's&p 500': '^GSPC',
    'sp500': '^GSPC',
    'nasdaq': '^IXIC',
    'dow jones': '^DJI',
    'dow': '^DJI',
    'qqq': 'QQQ',
    'vti': 'VTI',
    'voo': 'VOO',
    'ief': 'IEF',
    'gld': 'GLD',
    'slv': 'SLV'
  };
  
  // Commodities mapping
  const commodityMap = {
    'gold': 'GC=F',
    'silver': 'SI=F',
    'oil': 'CL=F',
    'crude oil': 'CL=F',
    'natural gas': 'NG=F',
    'copper': 'HG=F',
    'wheat': 'ZW=F',
    'corn': 'ZC=F'
  };
  
  const symbols = new Set();
  
  // Check for direct symbol patterns
  symbolPatterns.forEach(pattern => {
    const matches = prompt.match(pattern);
    if (matches) {
      matches.forEach(match => {
        let symbol = match.replace(/\\$|\\s+stock/gi, '').toUpperCase();
        if (symbol.length >= 1 && symbol.length <= 5) {
          symbols.add(symbol);
        }
      });
    }
  });
  
  // Check for all mappings
  const lowerPrompt = prompt.toLowerCase();
  const allMaps = { ...companyMap, ...cryptoMap, ...forexMap, ...etfIndexMap, ...commodityMap };
  
  Object.entries(allMaps).forEach(([key, symbol]) => {
    if (lowerPrompt.includes(key)) {
      symbols.add(symbol);
    }
  });
  
  return Array.from(symbols);
}

async function getCloudfrontDomain() {
  if (cachedDomain) return cachedDomain;
  
  try {
    const response = await secretsClient.send(new GetSecretValueCommand({
      SecretId: process.env.CLOUDFRONT_DOMAIN_SECRET
    }));
    cachedDomain = response.SecretString;
    return cachedDomain;
  } catch (error) {
    console.warn('Failed to get domain from secrets:', error);
    return 'https://' + process.env.APP_DOMAIN; // Fallback
  }
}

exports.handler = async (event) => {
  const cloudfrontDomain = await getCloudfrontDomain();
  
  const headers = {
    'Access-Control-Allow-Origin': cloudfrontDomain,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'POST,OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { action, modelId, prompt, conversationId, userId, fileData, fileName, fileType, enableWebSearch } = body;

    // Input validation
    if (!action || !userId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing required parameters' })
      };
    }

    if (action === 'invoke') {
      if (!modelId || !prompt || !conversationId) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Missing required parameters for invoke' })
        };
      }

      const allowedModels = await getAllowedModels();
      if (!allowedModels.includes(modelId)) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Model not allowed' })
        };
      }

      if (prompt.length > 10000) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Prompt too long' })
        };
      }

      // Handle image and video generation models
      if (modelId.includes('nova-canvas') || modelId.includes('nova-reel') || modelId.includes('stability')) {
        
        // Nova Reel requires async invocation
        if (modelId.includes('nova-reel')) {
          const outputPrefix = \`videos/\${userId}/\${Date.now()}\`;
          const outputS3Uri = \`s3://\${process.env.VIDEO_OUTPUT_BUCKET}/\${outputPrefix}/\`;
          
          const asyncCommand = new StartAsyncInvokeCommand({
            modelId,
            modelInput: {
              taskType: 'TEXT_VIDEO',
              textToVideoParams: {
                text: prompt
              },
              videoGenerationConfig: {
                durationSeconds: 6,
                fps: 24,
                dimension: '1280x720',
                seed: Math.floor(Math.random() * 2147483648)
              }
            },
            outputDataConfig: {
              s3OutputDataConfig: {
                s3Uri: outputS3Uri
              }
            }
          });
          
          const asyncResponse = await bedrock.send(asyncCommand);
          const invocationArn = asyncResponse.invocationArn;
          
          await ddb.send(new PutCommand({
            TableName: process.env.TABLE_NAME,
            Item: {
              userId,
              conversationId: \`\${conversationId}#\${Date.now()}\`,
              timestamp: Date.now(),
              prompt: prompt.substring(0, 1000),
              response: \`Video generation started. Invocation: \${invocationArn}\`,
              modelId,
              modelUsed: modelId
            }
          }));
          
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ 
              response: \`🎬 Video generation started for: "\${prompt}"\\n\\n⏱️ This takes 2-5 minutes to complete.\\n\\n📂 S3 Location: s3://\${process.env.VIDEO_OUTPUT_BUCKET}/\${outputPrefix}/\\n\\n🔗 Invocation ARN: \${invocationArn}\\n\\n⚠️ Once complete, the video will be at output.mp4 in a subfolder.\`,
              isVideoAsync: true,
              bucket: process.env.VIDEO_OUTPUT_BUCKET,
              prefix: outputPrefix,
              invocationArn: invocationArn
            })
          };
        }
        
        let mediaPayload;
        
        if (modelId.includes('nova-canvas')) {
          mediaPayload = {
            taskType: 'TEXT_IMAGE',
            textToImageParams: {
              text: prompt
            },
            imageGenerationConfig: {
              numberOfImages: 1,
              height: 1024,
              width: 1024,
              cfgScale: 8.0
            }
          };
        } else {
          // Stability AI models
          mediaPayload = {
            prompt: prompt,
            mode: 'text-to-image',
            aspect_ratio: '1:1',
            output_format: 'png'
          };
        }

        const mediaCommand = new InvokeModelCommand({
          modelId,
          body: JSON.stringify(mediaPayload),
          contentType: 'application/json'
        });

        const mediaResponse = await bedrock.send(mediaCommand);
        const mediaResult = JSON.parse(new TextDecoder().decode(mediaResponse.body));
        
        // Extract media data (only images supported now)
        const mediaData = mediaResult.images[0];
        const mediaContent = \`Generated image: "\${prompt}"\`;
        
        await ddb.send(new PutCommand({
          TableName: process.env.TABLE_NAME,
          Item: {
            userId,
            conversationId: \`\${conversationId}#\${Date.now()}\`,
            timestamp: Date.now(),
            prompt: prompt.substring(0, 1000),
            response: mediaContent,
            modelId,
            modelUsed: modelId
          }
        }));

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ 
            response: mediaContent,
            imageData: mediaData,
            isImage: true
          })
        };
      }

      // Get conversation history with limit - SHARED ACROSS ALL MODELS
      const historyResult = await ddb.send(new QueryCommand({
        TableName: process.env.TABLE_NAME,
        KeyConditionExpression: 'userId = :userId AND begins_with(conversationId, :convId)',
        ExpressionAttributeValues: { 
          ':userId': userId,
          ':convId': conversationId
        },
        ScanIndexForward: true,
        Limit: 20
      }));

      let payload;
      let messages = [];
      
      // Handle file upload for image analysis
      if (body.fileData && body.fileName) {
        const fileExtension = body.fileName.toLowerCase().split('.').pop();
        const supportedImageTypes = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
        
        if (supportedImageTypes.includes(fileExtension)) {
          if (modelId.includes('anthropic')) {
            messages = [{
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: \`image/\${fileExtension === 'jpg' ? 'jpeg' : fileExtension}\`,
                    data: body.fileData
                  }
                },
                {
                  type: 'text',
                  text: prompt
                }
              ]
            }];
          } else if (modelId.includes('nova')) {
            messages = [{
              role: 'user',
              content: [
                {
                  image: {
                    format: fileExtension === 'jpg' ? 'jpeg' : fileExtension,
                    source: { bytes: body.fileData }
                  }
                },
                {
                  text: prompt
                }
              ]
            }];
          }
        }
      }
      
      if (modelId.includes('anthropic')) {
        // Web search integration for Claude models
        let enhancedPrompt = prompt;
        
        // Check for stock symbols and get financial data
        const stockSymbols = detectStockSymbols(prompt);
        let stockContext = '';
        
        if (stockSymbols.length > 0) {
          const stockDataPromises = stockSymbols.slice(0, 3).map(symbol => getStockData(symbol)); // Limit to 3 symbols
          const stockResults = await Promise.all(stockDataPromises);
          
          const validStockData = stockResults.filter(data => data !== null);
          if (validStockData.length > 0) {
            stockContext = validStockData.map(stock => {
              let formattedData = \`\${stock.symbol} (\${stock.companyName || stock.assetType}) as of \${stock.marketDate}: \${stock.currency || '$'}\${stock.currentPrice} \${stock.change >= 0 ? '+' : ''}\${stock.change.toFixed(2)} (\${stock.changePercent.toFixed(2)}%)\`;
              
              // Add relevant metrics based on asset type
              if (stock.assetType === 'Stock' || stock.assetType === 'ETF') {
                formattedData += \` | Volume: \${stock.volume?.toLocaleString() || 'N/A'}\`;
                if (stock.peRatio) formattedData += \` | P/E: \${stock.peRatio.toFixed(2)}\`;
                if (stock.marketCap) formattedData += \` | Market Cap: $\${(stock.marketCap / 1e9).toFixed(1)}B\`;
              } else if (stock.assetType === 'Cryptocurrency') {
                formattedData += \` | Volume: \${stock.volume?.toLocaleString() || 'N/A'}\`;
                if (stock.marketCap) formattedData += \` | Market Cap: $\${(stock.marketCap / 1e9).toFixed(1)}B\`;
              } else if (stock.assetType === 'Forex') {
                formattedData += \` | Day Range: \${stock.dayLow?.toFixed(4)} - \${stock.dayHigh?.toFixed(4)}\`;
              } else if (stock.assetType === 'Commodity') {
                formattedData += \` | Volume: \${stock.volume?.toLocaleString() || 'N/A'} | Day Range: \${stock.dayLow?.toFixed(2)} - \${stock.dayHigh?.toFixed(2)}\`;
              } else if (stock.assetType === 'Index') {
                formattedData += \` | Day Range: \${stock.dayLow?.toFixed(2)} - \${stock.dayHigh?.toFixed(2)}\`;
              }
              
              return formattedData;
            }).join('\\n');
          }
        }
        
        if (enableWebSearch) {
          const tavilyApiKey = await getTavilyApiKey();
          if (tavilyApiKey) {
            const searchQuery = prompt.length > 100 ? prompt.substring(0, 100) : prompt;
            const searchResults = await performWebSearch(searchQuery, tavilyApiKey);
            
            if (searchResults && searchResults.results && searchResults.results.length > 0) {
              const searchContext = searchResults.results.map(result => 
                \`Title: \${result.title}\\nURL: \${result.url}\\nContent: \${result.content}\`
              ).join('\\n\\n');
              
              enhancedPrompt = \`Based on the following information, please answer the user's question: "\${prompt}"
\${stockContext ? \`\\nCurrent Stock Data:\\n\${stockContext}\\n\` : ''}
Web Search Results:
\${searchContext}

Please provide a comprehensive answer based on both the search results and your knowledge. When referencing sources, format URLs as clickable links using this format: [Link Text](URL)\`;
            }
          }
        } else if (stockContext) {
          enhancedPrompt = \`Based on the following current stock data, please answer the user's question: "\${prompt}"

Current Stock Data:
\${stockContext}

Please provide a comprehensive analysis based on this financial data and your knowledge.\`;
        }
        
        if (messages.length === 0) {
          // No file upload, use regular text conversation
          historyResult.Items?.forEach(item => {
            messages.push({ role: 'user', content: item.prompt });
            messages.push({ role: 'assistant', content: item.response });
          });
          
          const lowerPrompt = prompt.toLowerCase();
          // Data charts: bar, line, pie, scatter with data/numbers/statistics
          const isDataChart = (lowerPrompt.includes('bar') || lowerPrompt.includes('line') || lowerPrompt.includes('pie') || lowerPrompt.includes('scatter') || lowerPrompt.includes('chart') || lowerPrompt.includes('graph') || lowerPrompt.includes('plot')) && 
                             (lowerPrompt.includes('data') || lowerPrompt.includes('population') || lowerPrompt.includes('number') || lowerPrompt.includes('statistic') || lowerPrompt.includes('percent') || lowerPrompt.includes('count') || lowerPrompt.includes('sales') || lowerPrompt.includes('revenue') || lowerPrompt.includes('growth') || lowerPrompt.includes('countries') || lowerPrompt.includes('year') || lowerPrompt.includes('month'));
          // Also trigger for explicit chart keywords
          const isChart = isDataChart || lowerPrompt.includes('chart') || lowerPrompt.includes('graph') || lowerPrompt.includes('plot');
          const isDrawio = lowerPrompt.includes('drawio') || lowerPrompt.includes('draw.io') || lowerPrompt.includes('architecture diagram');
          // Mermaid: flowcharts, sequence diagrams, class diagrams, state diagrams - NOT data visualizations
          const isMermaid = (lowerPrompt.includes('flowchart') || lowerPrompt.includes('sequence diagram') || lowerPrompt.includes('class diagram') || lowerPrompt.includes('state diagram') || lowerPrompt.includes('mermaid') || lowerPrompt.includes('er diagram') || lowerPrompt.includes('entity relationship')) && !isDataChart;
          
          let finalPrompt = enhancedPrompt;
          
          if (isChart) {
            finalPrompt += '\\n\\nGenerate a Chart.js config in triple-backtick chart code blocks. Return ONLY valid JSON - no JavaScript functions. Include type, data (labels, datasets), and simple options. No callbacks or functions.';
          } else if (isDrawio) {
            finalPrompt += '\\n\\nIMPORTANT: Generate a complete draw.io XML diagram with AWS styling. Use triple backticks with drawio language tag.';
          } else if (isMermaid) {
            finalPrompt += '\\n\\nUse simple Mermaid syntax in triple-backtick mermaid code blocks. Do NOT include ---config or theme directives. Start directly with the diagram type like flowchart TD, sequenceDiagram, or classDiagram.';
          }
          
          messages.push({ role: 'user', content: finalPrompt });
        }
        
        payload = { 
          anthropic_version: "bedrock-2023-05-31", 
          messages: messages, 
          max_tokens: 8000 
        };
      } else if (modelId.includes('nova')) {
        const messages = [];
        historyResult.Items?.forEach(item => {
          messages.push({ role: 'user', content: [{ text: item.prompt }] });
          messages.push({ role: 'assistant', content: [{ text: item.response }] });
        });
        
        const lowerPrompt = prompt.toLowerCase();
        const isDataChart = (lowerPrompt.includes('bar') || lowerPrompt.includes('line') || lowerPrompt.includes('pie') || lowerPrompt.includes('scatter') || lowerPrompt.includes('chart') || lowerPrompt.includes('graph') || lowerPrompt.includes('plot')) && 
                           (lowerPrompt.includes('data') || lowerPrompt.includes('population') || lowerPrompt.includes('number') || lowerPrompt.includes('statistic') || lowerPrompt.includes('percent') || lowerPrompt.includes('count') || lowerPrompt.includes('sales') || lowerPrompt.includes('revenue') || lowerPrompt.includes('growth') || lowerPrompt.includes('countries') || lowerPrompt.includes('year') || lowerPrompt.includes('month'));
        const isChart = isDataChart || lowerPrompt.includes('chart') || lowerPrompt.includes('graph') || lowerPrompt.includes('plot');
        const isDrawio = lowerPrompt.includes('drawio') || lowerPrompt.includes('draw.io') || lowerPrompt.includes('architecture diagram');
        const isMermaid = (lowerPrompt.includes('flowchart') || lowerPrompt.includes('sequence diagram') || lowerPrompt.includes('class diagram') || lowerPrompt.includes('state diagram') || lowerPrompt.includes('mermaid') || lowerPrompt.includes('er diagram') || lowerPrompt.includes('entity relationship')) && !isDataChart;
        
        let enhancedPrompt = prompt;
        
        // Check for stock symbols and get financial data
        const stockSymbols = detectStockSymbols(prompt);
        let stockContext = '';
        
        if (stockSymbols.length > 0) {
          const stockDataPromises = stockSymbols.slice(0, 3).map(symbol => getStockData(symbol));
          const stockResults = await Promise.all(stockDataPromises);
          
          const validStockData = stockResults.filter(data => data !== null);
          if (validStockData.length > 0) {
            stockContext = validStockData.map(stock => 
              \`\${stock.symbol} (\${stock.companyName}): $\${stock.currentPrice} \${stock.change >= 0 ? '+' : ''}\${stock.change.toFixed(2)} (\${stock.changePercent.toFixed(2)}%) | Volume: \${stock.volume?.toLocaleString() || 'N/A'} | P/E: \${stock.peRatio?.toFixed(2) || 'N/A'} | Market Cap: $\${stock.marketCap ? (stock.marketCap / 1e9).toFixed(1) + 'B' : 'N/A'}\`
            ).join('\\n');
          }
        }
        
        // Web search integration for Nova models
        let searchResults = null;
        if (enableWebSearch) {
          const tavilyApiKey = await getTavilyApiKey();
          if (tavilyApiKey) {
            const searchQuery = prompt.length > 100 ? prompt.substring(0, 100) : prompt;
            searchResults = await performWebSearch(searchQuery, tavilyApiKey);
            
            if (searchResults && searchResults.results && searchResults.results.length > 0) {
              const searchContext = searchResults.results.map(result => 
                \`Title: \${result.title}\\nURL: \${result.url}\\nContent: \${result.content}\`
              ).join('\\n\\n');
              
              enhancedPrompt = \`Based on the following information, please answer the user's question: "\${prompt}"
\${stockContext ? \`\\nCurrent Stock Data:\\n\${stockContext}\\n\` : ''}
Web Search Results:
\${searchContext}

Please provide a comprehensive answer based on both the search results and your knowledge. When referencing sources, format URLs as clickable links using this format: [Link Text](URL)\`;
            }
          }
        } else if (stockContext) {
          enhancedPrompt = \`Based on the following current stock data, please answer the user's question: "\${prompt}"

Current Stock Data:
\${stockContext}

Please provide a comprehensive analysis based on this financial data and your knowledge.\`;
        }
        
        if (isChart) {
          enhancedPrompt += '\\n\\nGenerate a Chart.js config in triple-backtick chart code blocks. Return ONLY valid JSON - no JavaScript functions. Include type, data (labels, datasets), and simple options. No callbacks or functions.';
        } else if (isDrawio) {
          enhancedPrompt += '\\n\\nIMPORTANT: Generate a complete draw.io XML diagram with AWS styling. Use triple backticks with drawio language tag.';
        } else if (isMermaid) {
          enhancedPrompt += '\\n\\nUse simple Mermaid syntax in triple-backtick mermaid code blocks. Do NOT include ---config or theme directives. Start directly with the diagram type like flowchart TD, sequenceDiagram, or classDiagram.';
        }
        
        messages.push({ role: 'user', content: [{ text: enhancedPrompt }] });
        payload = { messages: messages };
        
        // Web search disabled - requires Converse API which has compatibility issues
        // Will be re-implemented in future update
      } else if (modelId.includes('llama')) {
        let contextPrompt = '';
        historyResult.Items?.forEach(item => {
          contextPrompt += \`Human: \${item.prompt}\\nAssistant: \${item.response}\\n\\n\`;
        });
        
        let finalPrompt = prompt;
        
        // Check for stock symbols and get financial data
        const stockSymbols = detectStockSymbols(prompt);
        let stockContext = '';
        
        if (stockSymbols.length > 0) {
          const stockDataPromises = stockSymbols.slice(0, 3).map(symbol => getStockData(symbol));
          const stockResults = await Promise.all(stockDataPromises);
          
          const validStockData = stockResults.filter(data => data !== null);
          if (validStockData.length > 0) {
            stockContext = validStockData.map(stock => 
              \`\${stock.symbol} (\${stock.companyName}): $\${stock.currentPrice} \${stock.change >= 0 ? '+' : ''}\${stock.change.toFixed(2)} (\${stock.changePercent.toFixed(2)}%) | Volume: \${stock.volume?.toLocaleString() || 'N/A'} | P/E: \${stock.peRatio?.toFixed(2) || 'N/A'} | Market Cap: $\${stock.marketCap ? (stock.marketCap / 1e9).toFixed(1) + 'B' : 'N/A'}\`
            ).join('\\n');
          }
        }
        
        // Web search integration for Llama models
        if (enableWebSearch) {
          const tavilyApiKey = await getTavilyApiKey();
          if (tavilyApiKey) {
            const searchQuery = prompt.length > 100 ? prompt.substring(0, 100) : prompt;
            const searchResults = await performWebSearch(searchQuery, tavilyApiKey);
            
            if (searchResults && searchResults.results && searchResults.results.length > 0) {
              const searchContext = searchResults.results.map(result => 
                \`Title: \${result.title}\\nURL: \${result.url}\\nContent: \${result.content}\`
              ).join('\\n\\n');
              
              finalPrompt = \`Based on the following information, please answer the user's question: "\${prompt}"
\${stockContext ? \`\\nCurrent Stock Data:\\n\${stockContext}\\n\` : ''}
Web Search Results:
\${searchContext}

Please provide a comprehensive answer based on both the search results and your knowledge. When referencing sources, format URLs as clickable links using this format: [Link Text](URL)\`;
            }
          }
        } else if (stockContext) {
          finalPrompt = \`Based on the following current stock data, please answer the user's question: "\${prompt}"

Current Stock Data:
\${stockContext}

Please provide a comprehensive analysis based on this financial data and your knowledge.\`;
        }
        
        contextPrompt += \`Human: \${finalPrompt}\\nAssistant:\`;
        
        payload = { prompt: contextPrompt, max_gen_len: 1000, temperature: 0.7 };
      } else {
        const messages = [];
        historyResult.Items?.forEach(item => {
          messages.push({ role: 'user', content: item.prompt });
          messages.push({ role: 'assistant', content: item.response });
        });
        messages.push({ role: 'user', content: prompt });
        payload = { messages: messages, max_tokens: 8000 };
      }

      // Use InvokeModel API for all models
      const command = new InvokeModelCommand({
        modelId,
        body: JSON.stringify(payload),
        contentType: 'application/json'
      });

      const response = await bedrock.send(command);
      const result = JSON.parse(new TextDecoder().decode(response.body));
      
      let content;
      if (modelId.includes('anthropic')) {
        content = result.content[0].text;
      } else if (modelId.includes('nova')) {
        content = result.output.message.content[0].text;
      } else if (modelId.includes('llama')) {
        content = result.generation;
      } else {
        content = result.content?.[0]?.text || result.output?.message?.content?.[0]?.text || 'No response';
      }

      // Ensure content is a string
      if (!content || typeof content !== 'string') {
        console.error('Invalid content format:', JSON.stringify(result, null, 2));
        content = 'Error: Unable to parse response from model';
      }

      await ddb.send(new PutCommand({
        TableName: process.env.TABLE_NAME,
        Item: {
          userId,
          conversationId: \`\${conversationId}#\${Date.now()}\`,
          timestamp: Date.now(),
          prompt: prompt.substring(0, 1000),
          response: content.substring(0, 5000),
          modelId,
          modelUsed: modelId // Track which model was used for this response
        }
      }));

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ response: content })
      };
    }

    if (action === 'history') {
      const result = await ddb.send(new QueryCommand({
        TableName: process.env.TABLE_NAME,
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': userId },
        ScanIndexForward: false,
        Limit: 20
      }));

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ conversations: result.Items })
      };
    }

    if (action === 'getVideoUrl') {
      const { bucket, prefix } = body;
      if (!bucket || !prefix) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing bucket or prefix' }) };
      }
      
      // List objects to find the output.mp4 in subfolder
      const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
      const listResult = await s3Client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix
      }));
      
      const videoFile = listResult.Contents?.find(obj => obj.Key.endsWith('output.mp4'));
      if (!videoFile) {
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'pending', message: 'Video still generating...' }) };
      }
      
      const presignedUrl = await getSignedUrl(s3Client, new GetObjectCommand({
        Bucket: bucket,
        Key: videoFile.Key
      }), { expiresIn: 86400 });
      
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'complete', url: presignedUrl }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid action' }) };
  } catch (error) {
    console.error('Bedrock API error:', error);
    console.error('Error details:', JSON.stringify(error, null, 2));
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error', details: error.message })
    };
  }
};
      `),
      environment: {
        TABLE_NAME: conversationsTable.tableName,
        CLOUDFRONT_DOMAIN_SECRET: cloudfrontDomainSecret.secretArn,
        ALLOWED_MODELS_SECRET: allowedModelsSecret.secretArn,
        TAVILY_API_SECRET: tavilySecret.secretArn,
        VIDEO_OUTPUT_BUCKET: videoOutputBucket.bucketName,
        APP_DOMAIN: fullDomain
      }
    });

    // Grant permissions
    conversationsTable.grantReadWriteData(bedrockLambda);
    videoOutputBucket.grantReadWrite(bedrockLambda);
    bedrockLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel', 'bedrock:StartAsyncInvoke', 'bedrock:GetAsyncInvoke'],
      resources: ['*']
    }));

    // Grant Nova grounding permissions for web search
    bedrockLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeTool'],
      resources: [`arn:aws:bedrock:*:${this.account}:system-tool/amazon.nova_grounding`]
    }));

    // Grant secrets access to Bedrock Lambda
    cloudfrontDomainSecret.grantRead(bedrockLambda);
    allowedModelsSecret.grantRead(bedrockLambda);
    tavilySecret.grantRead(bedrockLambda);

    // Create WAF Web ACL for API Gateway protection
    const webAcl = new wafv2.CfnWebACL(this, 'BedrockAssistantWAF', {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      description: 'WAF for Bedrock Assistant API Gateway',
      name: 'BedrockAssistantWAF',
      rules: [
        {
          name: 'RateLimitRule',
          priority: 1,
          statement: {
            rateBasedStatement: {
              limit: 100, // 100 requests per 5 minutes per IP
              aggregateKeyType: 'IP'
            }
          },
          action: { block: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'RateLimitRule'
          }
        },
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
              excludedRules: [
                { name: 'SizeRestrictions_BODY' }
              ]
            }
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'CommonRuleSetMetric'
          }
        },
        {
          name: 'AWSManagedRulesKnownBadInputsRuleSet',
          priority: 3,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet'
            }
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'KnownBadInputsMetric'
          }
        },
        {
          name: 'AWSManagedRulesAmazonIpReputationList',
          priority: 4,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesAmazonIpReputationList'
            }
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'IpReputationMetric'
          }
        }
      ],
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'BedrockAssistantWAF'
      }
    });

    // API Gateway with proper CORS and throttling
    const api = new apigateway.RestApi(this, 'BedrockApi', {
      restApiName: 'Bedrock Assistant API',
      defaultCorsPreflightOptions: {
        allowOrigins: [cloudfrontDomainSecret.secretValue.unsafeUnwrap()],
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization']
      }
    });

    const bedrockIntegration = new apigateway.LambdaIntegration(bedrockLambda);
    const bedrockResource = api.root.addResource('bedrock');
    bedrockResource.addMethod('POST', bedrockIntegration, {
      methodResponses: [{ statusCode: '200' }, { statusCode: '400' }, { statusCode: '500' }]
    });
    
    const passwordIntegration = new apigateway.LambdaIntegration(passwordLambda);
    const passwordResource = api.root.addResource('set-password');
    passwordResource.addMethod('POST', passwordIntegration, {
      methodResponses: [{ statusCode: '200' }, { statusCode: '400' }, { statusCode: '500' }]
    });
    
    const configIntegration = new apigateway.LambdaIntegration(configLambda);
    const configResource = api.root.addResource('config');
    configResource.addMethod('GET', configIntegration, {
      methodResponses: [{ statusCode: '200' }]
    });

    // Create usage plan for rate limiting
    const usagePlan = api.addUsagePlan('BedrockAssistantUsagePlan', {
      name: 'Bedrock Assistant Usage Plan',
      throttle: {
        rateLimit: 50,    // 50 requests per second
        burstLimit: 100   // 100 concurrent requests
      },
      quota: {
        limit: 10000,     // 10,000 requests per month
        period: apigateway.Period.MONTH
      }
    });

    // Associate usage plan with API stage
    usagePlan.addApiStage({
      stage: api.deploymentStage
    });

    // Associate WAF with API Gateway
    new wafv2.CfnWebACLAssociation(this, 'ApiGatewayWAFAssociation', {
      resourceArn: `arn:aws:apigateway:${this.region}::/restapis/${api.restApiId}/stages/${api.deploymentStage.stageName}`,
      webAclArn: webAcl.attrArn
    });

    // CloudFront WAF for additional protection
    const cloudfrontWebAcl = new wafv2.CfnWebACL(this, 'CloudFrontWAF', {
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      description: 'WAF for CloudFront distribution',
      name: 'BedrockAssistantCloudFrontWAF',
      rules: [
        {
          name: 'CloudFrontRateLimitRule',
          priority: 1,
          statement: {
            rateBasedStatement: {
              limit: 200, // 200 requests per 5 minutes per IP for static content
              aggregateKeyType: 'IP'
            }
          },
          action: { block: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'CloudFrontRateLimitRule'
          }
        },
        {
          name: 'AWSManagedRulesCommonRuleSetCloudFront',
          priority: 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet'
            }
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'CloudFrontCommonRuleSet'
          }
        }
      ],
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'BedrockAssistantCloudFrontWAF'
      }
    });

    // S3 bucket for frontend with security
    const websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true
    });

    // CloudFront OAC for secure S3 access
    const originAccessControl = new cloudfront.S3OriginAccessControl(this, 'OAC', {
      description: 'OAC for Bedrock Assistant'
    });

    // CloudFront distribution with custom domain and WAF
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(websiteBucket, {
          originAccessControl
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
          securityHeadersBehavior: {
            contentTypeOptions: { override: true },
            frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
            referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
            strictTransportSecurity: { 
              accessControlMaxAge: cdk.Duration.seconds(31536000), 
              includeSubdomains: true, 
              override: true 
            }
          }
        })
      },
      domainNames: [fullDomain],
      certificate: certificate,
      defaultRootObject: 'index.html',
      errorResponses: [{
        httpStatus: 404,
        responseHttpStatus: 200,
        responsePagePath: '/index.html'
      }],
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      webAclId: cloudfrontWebAcl.attrArn
    });

    // Create Route 53 record
    new route53.ARecord(this, 'AliasRecord', {
      zone: hostedZone,
      recordName: 'genai',
      target: route53.RecordTarget.fromAlias(new route53targets.CloudFrontTarget(distribution))
    });

    // Outputs
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'CloudFrontUrl', { value: `https://${distribution.domainName}` });
    new cdk.CfnOutput(this, 'CustomDomainUrl', { value: `https://${fullDomain}` });
    new cdk.CfnOutput(this, 'BucketName', { value: websiteBucket.bucketName });
    new cdk.CfnOutput(this, 'WAFWebAclArn', { value: webAcl.attrArn });
    new cdk.CfnOutput(this, 'CloudFrontWAFArn', { value: cloudfrontWebAcl.attrArn });
  }
}
