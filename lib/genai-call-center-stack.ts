import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as sqs from 'aws-cdk-lib/aws-sqs'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as iam from 'aws-cdk-lib/aws-iam'
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources'
import * as python from '@aws-cdk/aws-lambda-python-alpha'

interface GenAiCallCenterStackProps extends cdk.StackProps {
  knowledgeBaseRegion: string
  knowledgeBaseId: string
}

export class GenAiCallCenterStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GenAiCallCenterStackProps) {
    super(scope, id, props)

    const table = new dynamodb.Table(this, 'MessagesTable', {
      partitionKey: {
        name: 'contact_id',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'message_id',
        type: dynamodb.AttributeType.STRING,
      },
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    })

    const lambdaParameters = {
      entry: './functions/bot',
      handler: 'handler',
      runtime: lambda.Runtime.PYTHON_3_12,
      memorySize: 1024,
    }

    const queue = new sqs.Queue(this, 'Queue', {
      fifo: true,
      contentBasedDeduplication: true,
      visibilityTimeout: cdk.Duration.minutes(3),
      enforceSSL: true,
    })

    const starter = new python.PythonFunction(this, 'Stater', {
      ...lambdaParameters,
      index: 'starter.py',
      timeout: cdk.Duration.seconds(8),
      environment: {
        POWERTOOLS_SERVICE_NAME: 'starter',
        QUEUE_NAME: queue.queueName,
      },
    })
    queue.grantSendMessages(starter)

    const worker = new python.PythonFunction(this, 'Worker', {
      ...lambdaParameters,
      index: 'worker.py',
      timeout: cdk.Duration.minutes(3),
      environment: {
        POWERTOOLS_SERVICE_NAME: 'worker',
        MESSAGES_TABLE_NAME: table.tableName,
        KNOWLEDGE_BASE_ID: props.knowledgeBaseId,
      },
    })

    worker.addEventSource(
      new SqsEventSource(queue, {
        batchSize: 10,
      }),
    )

    table.grantReadWriteData(worker)
    worker.role?.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        'AmazonKinesisVideoStreamsReadOnlyAccess',
      ),
    )

    const workerPolicy = new iam.ManagedPolicy(this, 'WorkerPolicy', {
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'bedrock:InvokeModel',
            'transcribe:StartStreamTranscription',
          ],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['bedrock:Retrieve', 'transcribe:StartStreamTranscription'],
          resources: [
            `arn:aws:bedrock:${props.knowledgeBaseRegion}:${cdk.Stack.of(this).account}:knowledge-base/${props.knowledgeBaseId}`,
          ],
        }),
      ],
    })
    worker.role?.addManagedPolicy(workerPolicy)

    const checker = new python.PythonFunction(this, 'Checker', {
      ...lambdaParameters,
      index: 'checker.py',
      timeout: cdk.Duration.seconds(8),
      environment: {
        POWERTOOLS_SERVICE_NAME: 'checker',
        MESSAGES_TABLE_NAME: table.tableName,
      },
    })

    table.grantReadWriteData(checker)
  }
}
