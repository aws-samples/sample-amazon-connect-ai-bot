import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as bedrock from 'aws-cdk-lib/aws-bedrock'
import * as oss from 'aws-cdk-lib/aws-opensearchserverless'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as iam from 'aws-cdk-lib/aws-iam'

const UUID = '339C5FED-A1B5-43B6-B40A-5E8E59E5734D'

// parsingConfiguration has the ability to read images, graphs, and tables embedded in PDF files.
// You can define any prompt for reading. It is defined as a constant below. By changing the prompt according to your environment, you can expect higher accuracy.
// https://docs.aws.amazon.com/bedrock/latest/userguide/kb-chunking-parsing.html#kb-advanced-parsing
const PARSING_PROMPT = `Please transcribe text from image content such as images, graphs, and tables in the document, and output it in Markdown syntax that is not a code block.
Please follow these steps:

1. Carefully examine the provided page.

2. Identify all elements present on the page. This includes headings, body text, footnotes, tables, visualizations, captions, page numbers, etc.

3. Use Markdown syntax formatting for output:
- Headings: # for main headings, ## for sections, ### for subsections, etc.
- Lists: * or - for bullet points, 1. 2. 3. for numbered lists
- Avoid repetition

4. If the element is a Visualization:
- Provide a detailed description in natural language
- Do not transcribe text within the Visualization after providing the description

5. If the element is a table:
- Create a Markdown table, ensuring all rows have the same number of columns
- Maintain cell alignment as faithfully as possible
- Do not split the table into multiple tables
- If merged cells span multiple rows or columns, place the text in the top-left cell and output ' ' for other cells
- Use | for column separators and |-|-| for header row separators
- If a cell has multiple items, list them on separate lines
- If the table has subheaders, separate the subheaders from the headers on a different line

6. If the element is a paragraph:
- Transcribe each text element exactly as it appears

7. If the element is a header, footer, footnote, or page number:
- Transcribe each text element exactly as it appears

Output example:

A bar graph showing annual sales with "Sales ($millions)" on the Y-axis and "Year" on the X-axis. The graph has bars for 2018 ($12M), 2019 ($18M), 2020 ($8M), and 2021 ($22M).
Figure 3: This graph shows annual sales in millions of dollars. There was a significant decrease in 2020 due to the COVID-19 pandemic.

Annual Report
Financial Highlights
Revenue: $40M
Profit: $12M
EPS: $1.25
| | Year ended December 31 | |

2021	2022
Cash flows:		
Operating activities	$ 46,327	$ 46,752
Investing activities	(58,154)	(37,601)
Financing activities	6,291	9,718`

interface OpenSearchServerlessIndexProps {
  collectionId: string
  vectorIndexName: string
  vectorField: string
  metadataField: string
  textField: string
  vectorDimension: string
  ServiceTimeout: number
}

class OpenSearchServerlessIndex extends Construct {
  public readonly customResourceHandler: lambda.IFunction
  public readonly customResource: cdk.CustomResource

  constructor(
    scope: Construct,
    id: string,
    props: OpenSearchServerlessIndexProps,
  ) {
    super(scope, id)

    const customResourceHandler = new lambda.SingletonFunction(
      this,
      'OpenSearchServerlessIndex',
      {
        runtime: lambda.Runtime.NODEJS_20_X,
        code: lambda.Code.fromAsset('lib/custom-resources/oss-index'),
        handler: 'index.handler',
        uuid: UUID,
        lambdaPurpose: 'OpenSearchServerlessIndex',
        timeout: cdk.Duration.minutes(5),
      },
    )

    const customResource = new cdk.CustomResource(this, 'CustomResource', {
      serviceToken: customResourceHandler.functionArn,
      resourceType: 'Custom::OssIndex',
      properties: props,
    })

    this.customResourceHandler = customResourceHandler
    this.customResource = customResource
  }
}

interface KnowledgeBaseStackProps extends cdk.StackProps {
  embeddingModelId?: string
  vectorDimension?: number
  collectionName?: string
  enableStandbyReplicas?: boolean
  enableAdvancedParsing?: boolean
  advancedParsingModelId?: string
}

export class KnowledgeBaseStack extends cdk.Stack {
  public readonly knowledgeBaseId: string
  public readonly dataSourceBucketName: string

  constructor(scope: Construct, id: string, props: KnowledgeBaseStackProps) {
    super(scope, id, props)

    const embeddingModelId =
      props.embeddingModelId ?? 'amazon.titan-embed-text-v2:0'
    const vectorDimension = props.vectorDimension?.toString() ?? '1024'

    const collectionName = props.collectionName ?? 'genai-call-center'
    const vectorIndexName = 'bedrock-knowledge-base-default'
    const vectorField = 'bedrock-knowledge-base-default-vector'
    const textField = 'AMAZON_BEDROCK_TEXT_CHUNK'
    const metadataField = 'AMAZON_BEDROCK_METADATA'

    const knowledgeBaseRole = new iam.Role(this, 'KnowledgeBaseRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
    })

    const advancedParsingModelId =
      props.advancedParsingModelId ??
      'anthropic.claude-3-5-sonnet-20240620-v1:0'

    const collection = new oss.CfnCollection(this, 'Collection', {
      name: collectionName,
      description: 'GenAI CallCenter Collection',
      type: 'VECTORSEARCH',
      standbyReplicas: props.enableStandbyReplicas
        ? 'ENABLED'
        : ('DISABLED' as 'ENABLED' | 'DISABLED'),
    })

    const ossIndex = new OpenSearchServerlessIndex(this, 'OssIndex', {
      collectionId: collection.ref,
      vectorIndexName,
      vectorField,
      textField,
      metadataField,
      vectorDimension,
      ServiceTimeout: 60 * 3,
    })

    ossIndex.customResourceHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: [cdk.Token.asString(collection.getAtt('Arn'))],
        actions: ['aoss:APIAccessAll'],
      }),
    )

    const accessPolicy = new oss.CfnAccessPolicy(this, 'AccessPolicy', {
      name: collectionName,
      policy: JSON.stringify([
        {
          Rules: [
            {
              Resource: [`collection/${collectionName}`],
              Permission: [
                'aoss:DescribeCollectionItems',
                'aoss:CreateCollectionItems',
                'aoss:UpdateCollectionItems',
              ],
              ResourceType: 'collection',
            },
            {
              Resource: [`index/${collectionName}/*`],
              Permission: [
                'aoss:UpdateIndex',
                'aoss:DescribeIndex',
                'aoss:ReadDocument',
                'aoss:WriteDocument',
                'aoss:CreateIndex',
                'aoss:DeleteIndex',
              ],
              ResourceType: 'index',
            },
          ],
          Principal: [
            knowledgeBaseRole.roleArn,
            ossIndex.customResourceHandler.role?.roleArn,
          ],
          Description: '',
        },
      ]),
      type: 'data',
    })

    const networkPolicy = new oss.CfnSecurityPolicy(this, 'NetworkPolicy', {
      name: collectionName,
      policy: JSON.stringify([
        {
          Rules: [
            {
              Resource: [`collection/${collectionName}`],
              ResourceType: 'collection',
            },
            {
              Resource: [`collection/${collectionName}`],
              ResourceType: 'dashboard',
            },
          ],
          AllowFromPublic: true,
        },
      ]),
      type: 'network',
    })

    const encryptionPolicy = new oss.CfnSecurityPolicy(
      this,
      'EncryptionPolicy',
      {
        name: collectionName,
        policy: JSON.stringify({
          Rules: [
            {
              Resource: [`collection/${collectionName}`],
              ResourceType: 'collection',
            },
          ],
          AWSOwnedKey: true,
        }),
        type: 'encryption',
      },
    )

    collection.node.addDependency(accessPolicy)
    collection.node.addDependency(networkPolicy)
    collection.node.addDependency(encryptionPolicy)

    const dataSourceBucket = new s3.Bucket(this, 'DataSourceBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      enforceSSL: true,
    })

    knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: ['*'],
        actions: ['bedrock:InvokeModel', 'bedrock:Rerank'],
      }),
    )

    knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: [cdk.Token.asString(collection.getAtt('Arn'))],
        actions: ['aoss:APIAccessAll'],
      }),
    )

    knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: [`arn:aws:s3:::${dataSourceBucket.bucketName}`],
        actions: ['s3:ListBucket'],
      }),
    )

    knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: [`arn:aws:s3:::${dataSourceBucket.bucketName}/*`],
        actions: ['s3:GetObject'],
      }),
    )

    const knowledgeBase = new bedrock.CfnKnowledgeBase(this, 'KnowledgeBase', {
      name: collectionName,
      roleArn: knowledgeBaseRole.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:aws:bedrock:${this.region}::foundation-model/${embeddingModelId}`,
        },
      },
      storageConfiguration: {
        type: 'OPENSEARCH_SERVERLESS',
        opensearchServerlessConfiguration: {
          collectionArn: cdk.Token.asString(collection.getAtt('Arn')),
          fieldMapping: {
            metadataField,
            textField,
            vectorField,
          },
          vectorIndexName,
        },
      },
    })

    new bedrock.CfnDataSource(this, 'DataSource', {
      dataSourceConfiguration: {
        s3Configuration: {
          bucketArn: `arn:aws:s3:::${dataSourceBucket.bucketName}`,
          inclusionPrefixes: ['docs/'],
        },
        type: 'S3',
      },
      vectorIngestionConfiguration: {
        ...(props.enableAdvancedParsing
          ? {
              parsingConfiguration: {
                parsingStrategy: 'BEDROCK_FOUNDATION_MODEL',
                bedrockFoundationModelConfiguration: {
                  modelArn: `arn:aws:bedrock:${this.region}::foundation-model/${advancedParsingModelId}`,
                  parsingPrompt: {
                    parsingPromptText: PARSING_PROMPT,
                  },
                },
              },
            }
          : {}),
        chunkingConfiguration: {
          chunkingStrategy: 'HIERARCHICAL',
          hierarchicalChunkingConfiguration: {
            levelConfigurations: [
              {
                maxTokens: 1000,
              },
              {
                maxTokens: 300,
              },
            ],
            overlapTokens: 50,
          },
        },
      },
      knowledgeBaseId: knowledgeBase.ref,
      name: 's3-data-source',
    })

    knowledgeBase.addDependency(collection)
    knowledgeBase.node.addDependency(ossIndex.customResource)

    this.knowledgeBaseId = knowledgeBase.ref
    this.dataSourceBucketName = dataSourceBucket.bucketName

    new cdk.CfnOutput(this, 'KnowledgeBaseId', {
      value: knowledgeBase.ref,
    })
  }
}
