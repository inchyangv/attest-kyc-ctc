#!/usr/bin/env bash
# Create one t4g.micro for the worker: key pair from ~/.ssh, SSH-only security group,
# latest AL2023 arm64 AMI, user-data from this directory. Prints the instance id and IP.
#
#   AWS_PROFILE=stabled-prod AWS_REGION=ap-northeast-2 deploy/worker/provision.sh
set -euo pipefail
: "${AWS_PROFILE:=stabled-prod}"
: "${AWS_REGION:=ap-northeast-2}"
: "${KEY_PUB:=$HOME/.ssh/id_ed25519.pub}"
export AWS_PROFILE AWS_REGION
NAME=proofmark-worker
cd "$(dirname "$0")"

MY_IP="$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')/32"

aws ec2 describe-key-pairs --key-names "$NAME" >/dev/null 2>&1 \
  || aws ec2 import-key-pair --key-name "$NAME" --public-key-material "fileb://$KEY_PUB" >/dev/null

VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
[ "$VPC" != "None" ] || { echo "no default VPC in $AWS_REGION; pass a subnet manually" >&2; exit 1; }

SG=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=$NAME" "Name=vpc-id,Values=$VPC" \
     --query 'SecurityGroups[0].GroupId' --output text)
if [ "$SG" = "None" ]; then
  SG=$(aws ec2 create-security-group --group-name "$NAME" --description "Proofmark worker: SSH from operator only" \
       --vpc-id "$VPC" --query GroupId --output text)
fi
aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 22 --cidr "$MY_IP" >/dev/null 2>&1 || true

AMI=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 \
      --query Parameter.Value --output text)

ID=$(aws ec2 run-instances --image-id "$AMI" --instance-type t4g.micro --key-name "$NAME" \
     --security-group-ids "$SG" --user-data file://user-data.sh \
     --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
     --query 'Instances[0].InstanceId' --output text)
aws ec2 wait instance-running --instance-ids "$ID"
IP=$(aws ec2 describe-instances --instance-ids "$ID" \
     --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "instance=$ID ip=$IP sg=$SG ami=$AMI"
echo "next: deploy/worker/sync.sh $IP <private-worker-env-file>"
