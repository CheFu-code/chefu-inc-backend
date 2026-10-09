FROM matrixdotorg/synapse:v1.162.0

COPY synapse.yaml /etc/nook-matrix/synapse.yaml
COPY run-synapse.py /usr/local/bin/run-nook-synapse

ENTRYPOINT ["python3", "/usr/local/bin/run-nook-synapse"]
