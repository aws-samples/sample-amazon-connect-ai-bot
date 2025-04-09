import os
from pynamodb.models import Model
from pynamodb.attributes import UnicodeAttribute, NumberAttribute, BooleanAttribute


class MessageModel(Model):
    class Meta:
        table_name = os.environ["MESSAGES_TABLE_NAME"]

    contact_id = UnicodeAttribute(hash_key=True)
    message_id = UnicodeAttribute(range_key=True)
    role = UnicodeAttribute(null=False)
    text = UnicodeAttribute(null=True)
    is_error = BooleanAttribute(null=True)
    is_delivered = BooleanAttribute(null=True)
    ttl = NumberAttribute(null=False)
