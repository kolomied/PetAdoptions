#!/bin/bash

echo ---------------------------------------------------------------------------------------------
echo This script deploys petsite service, xray daemon and the CloudWatch agent to the EKS cluster
echo ---------------------------------------------------------------------------------------------

PETSITE_IMAGE_URL=$(aws cloudformation describe-stacks  --stack-name Services | jq '.Stacks[0].Outputs[] | select(.OutputKey == "imageURLValue").OutputValue')

sed -i '' "s~{{ECR_IMAGE_URL}}~$PETSITE_IMAGE_URL~" ../../../petsite/petsite/kubernetes/deployment.yaml

kubectl apply -f ../../../petsite/petsite/kubernetes/deployment.yaml

kubectl apply -f ../../../petsite/petsite/kubernetes/service.yaml

kubectl apply -f ../../../petsite/petsite/kubernetes/xray-daemon/xray-daemon-config.yaml

# Get current AWS REGION to deploy the CW agent
AWS_REGION=$(aws configure get region)

curl https://raw.githubusercontent.com/aws-samples/amazon-cloudwatch-container-insights/latest/k8s-deployment-manifest-templates/deployment-mode/daemonset/container-insights-monitoring/quickstart/cwagent-fluentd-quickstart.yaml | sed "s/{{cluster_name}}/petsite/;s/{{region_name}}/$AWS_REGION/" | kubectl apply -f -

# Wait a little bit for ELB to be created
sleep 5 

# GET address of the ELB
ELB=$(kubectl get service service-petsite -o json | jq -r '.status.loadBalancer.ingress[].hostname')
ELB="http://"$ELB

echo ----- Creating SSM Parameter -----

aws ssm put-parameter --name "/petstore/petsiteurl" --value $ELB --type "SecureString" --overwrite

echo ----- ✅ DONE --------