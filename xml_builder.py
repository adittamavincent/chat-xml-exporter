"""Builds the flat <user>/<response> XML from a list of (role, text) turns."""


def _wrap_cdata(text: str) -> str:
    # CDATA sections can't contain the literal "]]>" - split it across two
    # sections if it ever shows up (rare, but code blocks sometimes have it).
    text = text.replace("]]>", "]]]]><![CDATA[>")
    return f"<![CDATA[{text}]]>"


def build_xml(turns, root_tag="conversation"):
    """
    turns: list of (role, text) tuples, role is "user" or "response".
    root_tag: wrapping element name. Pass None/"" for a rootless flat
              sequence of <user>/<response> tags with no parent element
              (handy if you're pasting straight into something that doesn't
              need a single XML root, e.g. Cogdex/Notion).
    """
    body_lines = []
    for role, text in turns:
        tag = "user" if role == "user" else "response"
        body_lines.append(f"<{tag}>{_wrap_cdata(text)}</{tag}>")
    body = "\n".join(body_lines)

    if root_tag:
        return f"<{root_tag}>\n{body}\n</{root_tag}>\n"
    return body + "\n"
