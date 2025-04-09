import time
from typing import TypedDict, Optional, Literal

from aws_lambda_powertools.utilities.data_classes import ConnectContactFlowEvent
from aws_lambda_powertools.utilities.typing import LambdaContext

from models import MessageModel


class Response(TypedDict, total=False):
    message: Optional[str]
    status: Literal["IN_PROGRESS", "COMPLETED", "ERROR"]


def handler(event: ConnectContactFlowEvent, context: LambdaContext) -> Response:
    contact_id = event["Details"]["ContactData"]["ContactId"]
    return poll_latest_message(contact_id)


def poll_latest_message(contact_id: str) -> Response:
    max_attempts = 6
    attempts = 0

    while attempts < max_attempts:
        latest_messages = list(
            MessageModel.query(contact_id, scan_index_forward=False, limit=1)
        )

        if latest_messages:
            latest_message = latest_messages[0]

            if latest_message.role == "assistant" and not latest_message.is_delivered:
                latest_message.update(actions=[MessageModel.is_delivered.set(True)])
                if latest_message.is_error:
                    return {"status": "ERROR"}
                else:
                    return {"message": latest_message.text, "status": "COMPLETED"}

        time.sleep(1)
        attempts += 1

    return {"status": "IN_PROGRESS"}
