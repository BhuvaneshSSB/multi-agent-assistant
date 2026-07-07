"""Streamlit chat frontend for the multi-agent-assistant Mastra API."""

import os
import uuid

import requests
import streamlit as st

API_BASE_URL = os.environ.get("API_BASE_URL", "http://localhost:3000")
CHAT_ENDPOINT = f"{API_BASE_URL}/api/chat"

st.set_page_config(page_title="Multi-Agent Assistant", page_icon="🤖")
st.title("Multi-Agent Assistant")

# --- Session state -----------------------------------------------------
if "conversation_id" not in st.session_state:
    st.session_state.conversation_id = str(uuid.uuid4())
if "user_id" not in st.session_state:
    st.session_state.user_id = str(uuid.uuid4())
if "messages" not in st.session_state:
    st.session_state.messages = []  # list of {"role": "user"|"assistant", "content": str}

with st.sidebar:
    st.caption(f"conversationId: `{st.session_state.conversation_id}`")
    st.caption(f"userId: `{st.session_state.user_id}`")
    if st.button("New conversation"):
        st.session_state.conversation_id = str(uuid.uuid4())
        st.session_state.messages = []
        st.rerun()

# --- Render history ------------------------------------------------------
for msg in st.session_state.messages:
    with st.chat_message(msg["role"]):
        st.markdown(msg["content"])
        if msg.get("filename"):
            st.caption(f"📎 {msg['filename']}")

# --- Input row: file attaches to the next message sent -------------------
uploaded_file = st.file_uploader(
    "Attach a document (optional)",
    type=["pdf", "docx", "xlsx", "pptx", "csv"],
    key=f"uploader_{len(st.session_state.messages)}",
)
prompt = st.chat_input("Message the assistant...")

if prompt:
    user_text = prompt

    with st.chat_message("user"):
        st.markdown(user_text)
        if uploaded_file:
            st.caption(f"📎 {uploaded_file.name}")

    st.session_state.messages.append(
        {
            "role": "user",
            "content": user_text,
            "filename": uploaded_file.name if uploaded_file else None,
        }
    )

    data = {
        "conversationId": st.session_state.conversation_id,
        "userId": st.session_state.user_id,
    }
    if user_text:
        data["message"] = user_text

    files = None
    if uploaded_file is not None:
        files = {"file": (uploaded_file.name, uploaded_file.getvalue())}

    with st.chat_message("assistant"):
        with st.spinner("Thinking..."):
            try:
                response = requests.post(
                    CHAT_ENDPOINT, data=data, files=files, timeout=120
                )
                response.raise_for_status()
                payload = response.json()
                assistant_text = payload.get("assistantMessage", "(no response)")

                st.markdown(assistant_text)

                with st.expander("Details"):
                    st.json(
                        {
                            "agentsInvolved": payload.get("agentsInvolved"),
                            "document": payload.get("document"),
                            "retrieval": payload.get("retrieval"),
                            "executionTimeMs": payload.get("executionTimeMs"),
                        }
                    )
            except requests.exceptions.RequestException as e:
                assistant_text = f"Error contacting the assistant: {e}"
                st.error(assistant_text)

    st.session_state.messages.append({"role": "assistant", "content": assistant_text})
    st.rerun()
