import pickle
import requests
import ssl
import subprocess
import yaml

# ruleid: enclave-python-tls-verification-disabled
requests.get(url, verify=False)
# ok: enclave-python-tls-verification-disabled
requests.get(url, verify=True)
# ruleid: enclave-python-tls-verification-disabled
context.verify_mode = ssl.CERT_NONE
# ruleid: enclave-python-tls-verification-disabled
ssl._create_unverified_context()
# ruleid: enclave-python-unsafe-deserialization
pickle.loads(untrusted_data)
# ruleid: enclave-python-unsafe-deserialization
yaml.load(untrusted_data)
# ok: enclave-python-unsafe-deserialization
yaml.safe_load(untrusted_data)
# ruleid: enclave-python-shell-process-enabled
subprocess.run(command, shell=True)
# ok: enclave-python-shell-process-enabled
subprocess.run([command], shell=False)
