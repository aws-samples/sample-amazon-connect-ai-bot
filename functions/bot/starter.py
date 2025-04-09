import os
import json
from typing import TypedDict

import boto3
from aws_lambda_powertools.utilities.data_classes import ConnectContactFlowEvent
from aws_lambda_powertools.utilities.typing import LambdaContext

import config


class Audio(TypedDict):
    stream_arn: str
    start_timestamp: float
    end_timestamp: float


class Job(TypedDict):
    contact_id: str
    audio: Audio


sqs = boto3.client("sqs", config.MAIN_REGION_NAME)


def handler(event: ConnectContactFlowEvent, context: LambdaContext):
    contact_id = event["Details"]["ContactData"]["ContactId"]
    media_streams = event["Details"]["ContactData"]["MediaStreams"]["Customer"]["Audio"]

    job: Job = {
        "contact_id": contact_id,
        "audio": {
            "stream_arn": media_streams["StreamARN"],
            "start_timestamp": (float(media_streams["StartTimestamp"]) / 1000) + 3.0,
            "end_timestamp": (float(media_streams["StopTimestamp"]) / 1000) + 3.0,
        },
    }

    queue_url = sqs.get_queue_url(QueueName=os.environ["QUEUE_NAME"])["QueueUrl"]
    sqs.send_message(
        MessageGroupId=contact_id, QueueUrl=queue_url, MessageBody=json.dumps(job)
    )
