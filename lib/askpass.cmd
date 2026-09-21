@echo off
rem Git askpass launcher (Windows) - see askpass-main.mjs for the rationale.
rem git runs this as:  askpass.cmd "Username for 'https://host': "
rem %* forwards the prompt; keep it intact so the helper can parse it.
"%DSH_GIT_ASKPASS_NODE%" "%DSH_GIT_ASKPASS_MAIN%" %*
