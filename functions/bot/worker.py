import os
import json
from enum import Enum
from decimal import Decimal
from typing import TypedDict, Any, Union, Optional
from datetime import datetime

import boto3
from botocore.config import Config
import asyncio
from ebmlite import loadSchema
from uuid6 import uuid7
from aws_lambda_powertools import Logger
from aws_lambda_powertools.utilities.data_classes import SQSEvent
from aws_lambda_powertools.utilities.typing import LambdaContext
from amazon_transcribe.client import TranscribeStreamingClient
from amazon_transcribe.handlers import TranscriptResultStreamHandler
from amazon_transcribe.model import TranscriptEvent

from starter import Job
from models import MessageModel
import config

kvs_client = boto3.client("kinesisvideo", region_name=config.MAIN_REGION_NAME)
s3_client = boto3.client("s3", region_name=config.MAIN_REGION_NAME)
boto3_retry_config = Config(retries={"max_attempts": 10, "mode": "standard"})
bedrock_runtime_client = boto3.client(
    "bedrock-runtime", region_name=config.BEDROCK_REGION_NAME, config=boto3_retry_config
)
bedrock_agent_client = boto3.client(
    "bedrock-agent-runtime",
    region_name=config.BEDROCK_REGION_NAME,
    config=boto3_retry_config,
)
logger = Logger()


def handler(event: SQSEvent, context: LambdaContext) -> None:
    for record in event["Records"]:
        job = json.loads(record["body"])
        process_job(job)


def process_job(job: Job):
    user_message = MessageModel(job["contact_id"], str(uuid7()))
    user_message.role = "user"

    assistant_message = MessageModel(job["contact_id"], str(uuid7()))
    assistant_message.role = "assistant"
    assistant_message.is_delivered = False

    try:
        text = transcribe(job)

        user_message.text = text
        user_message.ttl = int(
            (datetime.now() + config.MESSAGE_RETENTION_PERIOD).timestamp()
        )
        user_message.save()

        assistant_message.ttl = int(
            (datetime.now() + config.MESSAGE_RETENTION_PERIOD).timestamp()
        )

        documents = retrieve(text)
        answer = generate_answer(fetch_messages(job["contact_id"]), documents)
        assistant_message.text = answer
        assistant_message.is_error = False

    except Exception as e:
        logger.error(e)
        assistant_message.is_error = True

    assistant_message.save()


def transcribe(job: Job) -> str:
    combined_samples = create_audio_sample(
        get_simple_blocks(
            get_media_data(
                job["audio"]["stream_arn"],
                job["audio"]["start_timestamp"],
                job["audio"]["end_timestamp"],
            )
        )
    )

    loop = asyncio.get_event_loop()
    event_handler = loop.run_until_complete(
        perform_streaming_transcription(combined_samples)
    )
    return "".join(event_handler.get_all_transcripts())


def fetch_messages(contact_id: str) -> list[dict]:
    messages = []

    for message in MessageModel.query(contact_id, scan_index_forward=True):
        messages.append(message.__dict__)
    return messages


class Document(TypedDict):
    text: str


def retrieve(query: str) -> list[Document]:
    documents = []
    response = bedrock_agent_client.retrieve(
        knowledgeBaseId=os.environ["KNOWLEDGE_BASE_ID"],
        retrievalConfiguration={
            "vectorSearchConfiguration": {
                "numberOfResults": config.NUMBER_OF_VECTOR_SEARCH_RESULT,
                "overrideSearchType": "HYBRID",
                "rerankingConfiguration": {
                    "bedrockRerankingConfiguration": {
                        "metadataConfiguration": {
                            "selectionMode": "ALL",
                        },
                        "modelConfiguration": {
                            "modelArn": f"arn:aws:bedrock:{config.BEDROCK_REGION_NAME}::foundation-model/{config.RERANK_MODEL_ID}"
                        },
                        "numberOfRerankedResults": config.NUMBER_OF_RERANKED_RESULT,
                    },
                    "type": "BEDROCK_RERANKING_MODEL",
                },
            },
        },
        retrievalQuery={"text": query},
    )
    for result in response["retrievalResults"]:
        documents.append(
            Document(
                text=result["content"]["text"],
            )
        )

    return documents


def generate_answer(messages: list[dict], documents: list[Document]) -> str:
    prompt = config.GENERATING_PROMPT.replace(
        "$messages$", json.dumps(messages, indent=2, ensure_ascii=False)
    ).replace("$documents$", json.dumps(documents, indent=2, ensure_ascii=False))

    response = bedrock_runtime_client.converse(
        modelId=config.GENERATING_MODEL_ID,
        messages=[{"role": "user", "content": [{"text": prompt}]}],
    )
    answer = response["output"]["message"]["content"][0]["text"]
    return answer


def decimal_to_int(dec: Decimal) -> int:
    if isinstance(dec, Decimal):
        return int(dec)


class Mkv(Enum):
    SEGMENT = 0x18538067
    CLUSTER = 0x1F43B675
    SIMPLEBLOCK = 0xA3


class Ebml(Enum):
    EBML = 0x1A45DFA3


class KVSParser:
    def __init__(self, media_content: dict[str, Any]):
        self.__stream = media_content["Payload"]
        self.__schema = loadSchema("matroska.xml")
        self.__buffer = bytearray()

    @property
    def fragments(self) -> list[Any]:
        return [
            fragment for chunk in self.__stream if (fragment := self.__parse(chunk))
        ]

    def __parse(self, chunk: bytes) -> Union[Any, None]:
        self.__buffer.extend(chunk)
        header_elements = [
            e for e in self.__schema.loads(self.__buffer) if e.id == Ebml.EBML.value
        ]
        if header_elements:
            fragment_dom = self.__schema.loads(
                self.__buffer[: header_elements[0].offset]
            )
            self.__buffer = self.__buffer[header_elements[0].offset :]
            return fragment_dom


def get_simple_blocks(media_content: dict[str, Any]) -> list[bytes]:
    parser = KVSParser(media_content)
    return [
        b.value
        for document in parser.fragments
        for b in next(
            filter(
                lambda c: c.id == Mkv.CLUSTER.value,
                next(filter(lambda s: s.id == Mkv.SEGMENT.value, document)),
            )
        )
        if b.id == Mkv.SIMPLEBLOCK.value
    ]


def create_audio_sample(simple_blocks: list[bytes], margin: int = 4) -> bytearray:
    position = 0
    total_length = sum(len(block) - margin for block in simple_blocks)
    combined_samples = bytearray(total_length)
    for block in simple_blocks:
        temp = block[margin:]
        combined_samples[position : position + len(temp)] = temp
        position += len(temp)
    return combined_samples


def create_archive_media_client(ep: str) -> boto3.client: # type: ignore
    return boto3.client(
        "kinesis-video-archived-media", endpoint_url=ep, config=Config()
    )


def get_media_data(
    arn: str, start_timestamp: float, end_timestamp: float
) -> dict[str, Any]:
    list_frags_ep = kvs_client.get_data_endpoint(
        StreamARN=arn, APIName="LIST_FRAGMENTS"
    )["DataEndpoint"]
    list_frags_client = create_archive_media_client(list_frags_ep)

    fragment_list = list_frags_client.list_fragments(
        StreamARN=arn,
        FragmentSelector={
            "FragmentSelectorType": "PRODUCER_TIMESTAMP",
            "TimestampRange": {
                "StartTimestamp": start_timestamp,
                "EndTimestamp": end_timestamp,
            },
        },
    )

    sorted_fragments = sorted(
        fragment_list["Fragments"], key=lambda fragment: fragment["ProducerTimestamp"]
    )
    fragment_number_array = [
        fragment["FragmentNumber"] for fragment in sorted_fragments
    ]

    get_media_ep = kvs_client.get_data_endpoint(
        StreamARN=arn, APIName="GET_MEDIA_FOR_FRAGMENT_LIST"
    )["DataEndpoint"]
    get_media_client = create_archive_media_client(get_media_ep)

    media = get_media_client.get_media_for_fragment_list(
        StreamARN=arn, Fragments=fragment_number_array
    )

    return media


class TranscriptionEventHandler(TranscriptResultStreamHandler):
    def __init__(self, stream):
        super().__init__(stream)
        self.transcripts: list[str] = []
        self.latest_partial: Optional[str] = None

    async def handle_transcript_event(self, transcript_event: TranscriptEvent):
        results = transcript_event.transcript.results

        for result in results:
            for alt in result.alternatives: # type: ignore
                if result.is_partial:
                    self.latest_partial = alt.transcript
                else:
                    self.transcripts.append(alt.transcript)
                    self.latest_partial = None

    def get_all_transcripts(self):
        if self.latest_partial:
            return self.transcripts + [self.latest_partial]
        return self.transcripts


async def perform_streaming_transcription(
    combined_samples: bytearray,
) -> TranscriptionEventHandler:
    client = TranscribeStreamingClient(region=config.MAIN_REGION_NAME)

    transcription_params = {
        "language_code": config.LANGUAGE_CODE,
        "media_sample_rate_hz": 8000,
        "media_encoding": "pcm",
    }
    
    if config.CUSTOM_VOCABULARY_NAME is not None:
        transcription_params["vocabulary_name"] = config.CUSTOM_VOCABULARY_NAME
    
    stream = await client.start_stream_transcription(**transcription_params)

    async def write_chunks():
        try:
            chunk_size = 1024 * 8
            for i in range(0, len(combined_samples), chunk_size):
                chunk = combined_samples[i : i + chunk_size]
                await stream.input_stream.send_audio_event(audio_chunk=chunk)
            await stream.input_stream.end_stream()
        except Exception as e:
            logger.error(e)

    event_handler = TranscriptionEventHandler(stream.output_stream)
    await asyncio.gather(write_chunks(), event_handler.handle_events())

    return event_handler
