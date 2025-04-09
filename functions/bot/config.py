from datetime import timedelta

# Region using Amazon Connect.
MAIN_REGION_NAME = "us-west-2"
# Region using Amazon Bedrock.
BEDROCK_REGION_NAME = "us-west-2"

# The language code to use in Amazon Transcribe.
LANGUAGE_CODE = 'en-US'
# LANGUAGE_CODE = 'ja-JP'

# Duration of storing conversation history in the database.
MESSAGE_RETENTION_PERIOD = timedelta(days=7)

# If you are using a custom vocabulary for Amazon Transcribe, please specify the name.
CUSTOM_VOCABULARY_NAME = None
# CUSTOM_VOCABULARY_NAME = "sample-vocabulary"

# Becrock models.
GENERATING_MODEL_ID = "us.anthropic.claude-3-5-sonnet-20241022-v2:0"
RERANK_MODEL_ID = "amazon.rerank-v1:0"

# Prompt text. If you wish to speak in a language other than English, specify the language. e.g. "日本語で会話して下さい"
GENERATING_PROMPT = """<instructions>
You are a question-answering agent. Please consider the past interactions and provide a concise response only to the most recent message.
As the text will be read aloud during a call, please avoid using bullet points and write in a way that is easy to understand orally.
Use English in your replies.

<messages>$messages$</messages>

<documents>$documents$</documents>"""

# Number of documents to retrieve
NUMBER_OF_VECTOR_SEARCH_RESULT = 50
NUMBER_OF_RERANKED_RESULT = 3
