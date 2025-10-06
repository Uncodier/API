# Azure OpenAI Setup Guide

This guide helps you configure Azure OpenAI for use with the custom automation library.

## Prerequisites

1. An Azure subscription
2. Azure OpenAI resource created in Azure Portal
3. A model deployment (e.g., GPT-4o, GPT-4, etc.)

## Step 1: Create Azure OpenAI Resource

1. Go to [Azure Portal](https://portal.azure.com)
2. Click "Create a resource"
3. Search for "Azure OpenAI"
4. Click "Create"
5. Fill in the required information:
   - **Subscription**: Select your subscription
   - **Resource group**: Create new or use existing
   - **Region**: Choose a region (e.g., East US, West Europe)
   - **Name**: Enter a unique name (e.g., `my-openai-resource`)
   - **Pricing tier**: Select appropriate tier
6. Click "Review + create" then "Create"

## Step 2: Create a Model Deployment

1. Navigate to your Azure OpenAI resource
2. Go to "Model deployments" or click "Go to Azure OpenAI Studio"
3. In Azure OpenAI Studio, go to "Deployments"
4. Click "Create new deployment"
5. Configure the deployment:
   - **Select a model**: Choose `gpt-4o`, `gpt-4`, or `gpt-35-turbo`
   - **Deployment name**: Enter a name (e.g., `gpt-4o`)
   - **Model version**: Select latest
   - **Deployment type**: Standard
6. Click "Create"

**Important**: Remember the deployment name you chose - you'll need it for configuration.

## Step 3: Get Your API Credentials

1. In Azure OpenAI Studio or Azure Portal:
   - Go to your Azure OpenAI resource
   - Click "Keys and Endpoint" in the left menu
2. Copy the following:
   - **Endpoint**: e.g., `https://your-resource-name.openai.azure.com`
   - **Key 1** or **Key 2**: Your API key

## Step 4: Configure Environment Variables

Add these variables to your `.env` file:

```bash
# Microsoft Azure OpenAI Configuration (Direct Robot Execution - separate from Portkey)
MICROSOFT_AZURE_OPENAI_ENDPOINT=https://your-resource-name.openai.azure.com
MICROSOFT_AZURE_OPENAI_API_KEY=your_api_key_here
MICROSOFT_AZURE_OPENAI_DEPLOYMENT=gpt-4o
MICROSOFT_AZURE_OPENAI_API_VERSION=2024-08-01-preview

# Scrapybara (for instance management)
SCRAPYBARA_API_KEY=your_scrapybara_api_key
```

### Configuration Details

- **MICROSOFT_AZURE_OPENAI_ENDPOINT**: Your Azure OpenAI resource endpoint (include https://)
- **MICROSOFT_AZURE_OPENAI_API_KEY**: Either Key 1 or Key 2 from Azure Portal (separate from Portkey's AZURE_OPENAI_API_KEY)
- **MICROSOFT_AZURE_OPENAI_DEPLOYMENT**: The deployment name you created (e.g., `gpt-4o`)
- **MICROSOFT_AZURE_OPENAI_API_VERSION**: API version (use `2024-08-01-preview` for latest features)

## Step 5: Verify Installation

Create a test file to verify the setup:

```typescript
import { OpenAIAgentExecutor } from '@/lib/custom-automation';

async function testSetup() {
  try {
    const executor = new OpenAIAgentExecutor();
    console.log('✅ Azure OpenAI configured successfully!');
  } catch (error) {
    console.error('❌ Configuration error:', error.message);
  }
}

testSetup();
```

If you see "✅ Azure OpenAI configured successfully!", you're all set!

## Troubleshooting

### Error: "Azure OpenAI endpoint is required"

- Make sure `AZURE_OPENAI_ENDPOINT` is set in your `.env` file
- Verify the endpoint includes `https://` protocol
- Check that the endpoint matches your Azure resource

### Error: "Azure OpenAI API key is required"

- Ensure `MICROSOFT_AZURE_OPENAI_API_KEY` is set in your `.env` file
- Verify you copied the key correctly from Azure Portal
- Try using Key 2 if Key 1 doesn't work
- Make sure you're not using the Portkey's `AZURE_OPENAI_API_KEY` by mistake

### Error: "The API deployment for this resource does not exist"

- Check that `AZURE_OPENAI_DEPLOYMENT` matches the name you created
- Verify the deployment is in "Succeeded" state in Azure Portal
- Ensure the deployment name is exactly as shown in Azure (case-sensitive)

### Error: "Resource not found"

- Verify your endpoint URL is correct
- Check that your Azure OpenAI resource is active
- Ensure you're using the correct Azure subscription

### Error: "Invalid API version"

- Try using `2024-08-01-preview` for latest features
- Or use a stable version like `2024-02-01`
- Check [Azure OpenAI API versions](https://learn.microsoft.com/azure/ai-services/openai/reference)

## API Versions

| Version | Status | Features |
|---------|--------|----------|
| `2024-08-01-preview` | Preview | Latest features, structured outputs |
| `2024-06-01` | Stable | Function calling, JSON mode |
| `2024-02-01` | Stable | General availability |

Recommendation: Use `2024-08-01-preview` for development, stable versions for production.

## Regional Availability

Azure OpenAI is available in multiple regions:

- **East US**
- **East US 2**
- **South Central US**
- **West Europe**
- **France Central**
- **UK South**
- **Sweden Central**
- **Switzerland North**

Choose a region close to your users for lower latency.

## Cost Management

### Pricing Structure

Azure OpenAI pricing is based on:
1. **Prompt tokens**: Input text
2. **Completion tokens**: Generated text
3. **Model type**: GPT-4o, GPT-4, GPT-3.5-Turbo

### Cost Optimization Tips

1. **Use GPT-3.5-Turbo** for simple tasks (much cheaper)
2. **Use GPT-4o-mini** for most tasks (good balance)
3. **Use GPT-4o** only when needed (most expensive)
4. **Monitor usage** in Azure Portal
5. **Set spending limits** in Azure Cost Management
6. **Optimize prompts** to reduce token usage

### Example Pricing (as of 2024)

- GPT-4o: ~$5-10 per 1M tokens
- GPT-4: ~$30-60 per 1M tokens
- GPT-3.5-Turbo: ~$0.50-2 per 1M tokens

*Note: Check Azure pricing page for current rates*

## Security Best Practices

1. **Never commit API keys** to version control
2. **Use environment variables** for all secrets
3. **Rotate keys regularly** in Azure Portal
4. **Use managed identities** for production (when possible)
5. **Monitor API usage** for anomalies
6. **Set up alerts** for unusual activity
7. **Use separate keys** for dev/staging/production

## Next Steps

Now that Azure OpenAI is configured:

1. Read the [README.md](./README.md) for usage examples
2. Check [MIGRATION_GUIDE.md](./MIGRATION_GUIDE.md) to migrate from Scrapybara SDK
3. Review [example-usage.ts](./example-usage.ts) for code examples
4. Test with [test-example.ts](./test-example.ts)

## Resources

- [Azure OpenAI Documentation](https://learn.microsoft.com/azure/ai-services/openai/)
- [Azure OpenAI API Reference](https://learn.microsoft.com/azure/ai-services/openai/reference)
- [OpenAI SDK for Azure](https://github.com/openai/openai-node)
- [Azure Pricing Calculator](https://azure.microsoft.com/pricing/calculator/)

## Support

For issues with:
- **Azure setup**: Contact Azure Support
- **Custom automation library**: Check README.md or create an issue
- **Scrapybara**: Check [Scrapybara documentation](https://docs.scrapybara.com)

