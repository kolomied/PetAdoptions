import * as cdk from '@aws-cdk/core';
import * as iam from '@aws-cdk/aws-iam';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as ecs from '@aws-cdk/aws-ecs';
import * as ecs_patterns from '@aws-cdk/aws-ecs-patterns';
import * as lambda from '@aws-cdk/aws-lambda';
import * as apigw from '@aws-cdk/aws-apigateway';
import * as sns from '@aws-cdk/aws-sns'
import * as sqs from '@aws-cdk/aws-sqs'
import * as subs from '@aws-cdk/aws-sns-subscriptions'
import * as ddb from '@aws-cdk/aws-dynamodb'
import * as s3 from '@aws-cdk/aws-s3'
import * as ddbseeder from 'aws-cdk-dynamodb-seeder'
import * as s3seeder from '@aws-cdk/aws-s3-deployment'
import * as rds from '@aws-cdk/aws-rds';

// https://stackoverflow.com/questions/59710635/how-to-connect-aws-ecs-applicationloadbalancedfargateservice-private-ip-to-rds

export class Services extends cdk.Stack {
    constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);


        // Create SQS resource to send Pet adoption messages to
        const sqsQueue = new sqs.Queue(this, 'sqs_petadoption', {
            visibilityTimeout: cdk.Duration.seconds(300)
        });

        // Create SNS and an email topic to send notifications to
        const topic_petadoption = new sns.Topic(this, 'topic_petadoption');
        topic_petadoption.addSubscription(new subs.EmailSubscription(this.node.tryGetContext('snstopic_email')));

        // Creates an S3 bucket to store pet images
        const s3_observabilitypetadoptions = new s3.Bucket(this, 's3bucket_petadoption', {
            bucketName: this.node.tryGetContext('s3bucket_name'),
            publicReadAccess: false
        });

        // Creates the DynamoDB table for Petadoption data
        const dynamodb_petadoption = new ddb.Table(this, 'ddb_petadoption', {
            partitionKey: {
                name: 'pettype',
                type: ddb.AttributeType.STRING
            },
            sortKey: {
                name: 'petid',
                type: ddb.AttributeType.STRING
            },
            tableName: this.node.tryGetContext('ddbtable_name')
        });

        // Seeds the petadoptions dynamodb table with all data required
        new ddbseeder.Seeder(this, "ddb_seeder_petadoption", {
            table: dynamodb_petadoption,
            setup: require("../resources/seed-data.json"),
            teardown: require("../resources/delete-seed-data.json"),
            refreshOnUpdate: true  // runs setup and teardown on every update, default false
        });

        // Seeds the S3 bucket with pet images
        new s3seeder.BucketDeployment(this, "s3seeder_petadoption", {
            destinationBucket: s3_observabilitypetadoptions,
            sources: [s3seeder.Source.asset('./resources/kitten.zip'), s3seeder.Source.asset('./resources/puppies.zip'), s3seeder.Source.asset('./resources/bunnies.zip')]
        });


        // The VPC where all the microservices will be deployed into
        const theVPC = new ec2.Vpc(this, 'Microservices', {
            cidr: this.node.tryGetContext('vpc_cidr'),
            natGateways: 1,
            maxAzs: 2
        });

        // Create RDS SQL Server DB instance

        const rdssecuritygroup = new ec2.SecurityGroup(this, 'petadoptionsrdsSG',
            {
                vpc: theVPC, securityGroupName: this.node.tryGetContext('rdssecuritygroup')
            });

        rdssecuritygroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(1433), 'allow MSSQL access from the world');

        const rdsPasswordSecret = new cdk.SecretValue(this.node.tryGetContext('rdspassword'));

        const instance = new rds.DatabaseInstance(this, 'Instance', {
            engine: rds.DatabaseInstanceEngine.SQL_SERVER_WEB,
            instanceClass: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE2, ec2.InstanceSize.SMALL),
            masterUsername: this.node.tryGetContext('rdsusername'),
            masterUserPassword: rdsPasswordSecret,
            deletionProtection: false,
            vpc: theVPC,
            licenseModel: rds.LicenseModel.LICENSE_INCLUDED,
            securityGroups: [rdssecuritygroup]
        });



        const logging = new ecs.AwsLogDriver({
            streamPrefix: "ecs-logs"
        });

        const executionRolePolicy = new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            resources: ['*'],
            actions: [
                "ecr:GetAuthorizationToken",
                "ecr:BatchCheckLayerAvailability",
                "ecr:GetDownloadUrlForLayer",
                "ecr:BatchGetImage",
                "logs:CreateLogStream",
                "logs:PutLogEvents",
                "xray:PutTraceSegments",
                "xray:PutTelemetryRecords"
            ]
        });

        const readSSMParamsPolicy = new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['ssm:GetParametersByPath',
                'ssm:GetParameters',
                'ssm:GetParameter'],
            resources: ['*']
        });

        // PayForAdoption service definitions-----------------------------------------------------------------------

        const taskRole_PayForAdoption = new iam.Role(this, `ecs-TaskRole-PayForAdoption-${this.stackName}`, {
            roleName: `ecs-taskRole-PayForAdoption-${this.stackName}`,
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
        });

        const payForAdoptionTaskDef = new ecs.FargateTaskDefinition(this, "ecs-taskdef-payforadoption", {
            taskRole: taskRole_PayForAdoption,
            cpu: 1024,
            memoryLimitMiB: 2048
        });

        payForAdoptionTaskDef.addToExecutionRolePolicy(executionRolePolicy);

        payForAdoptionTaskDef.taskRole?.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this, 'PayForAdoption-AmazonECSTaskExecutionRolePolicy', 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'));
        payForAdoptionTaskDef.taskRole?.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this, 'PayForAdoption-AWSXrayWriteOnlyAccess', 'arn:aws:iam::aws:policy/AWSXrayWriteOnlyAccess'));
        payForAdoptionTaskDef.taskRole?.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this, 'PayForAdoption-AmazonRDSFullAccess', 'arn:aws:iam::aws:policy/AmazonRDSFullAccess'));
        payForAdoptionTaskDef.taskRole?.addToPolicy(readSSMParamsPolicy);

        payForAdoptionTaskDef.addContainer('payforadoption', {
            image: ecs.ContainerImage.fromRegistry("awsimaya/payforadoption:latest"),
            memoryLimitMiB: 256,
            cpu: 256,
            logging
        }).addPortMappings({
            containerPort: 80,
            protocol: ecs.Protocol.TCP
        });

        payForAdoptionTaskDef.addContainer('xraydaemon', {
            image: ecs.ContainerImage.fromRegistry('amazon/aws-xray-daemon'),
            memoryLimitMiB: 256,
            cpu: 256,
            logging
        }).addPortMappings({
            containerPort: 2000,
            protocol: ecs.Protocol.UDP
        });

        const payforadoptionservice = new ecs_patterns.ApplicationLoadBalancedFargateService(this, "PayForAdoption-service", {
            cluster: new ecs.Cluster(this, "PayForAdoption-cluster", {
                vpc: theVPC,
                containerInsights: true
            }),
            taskDefinition: payForAdoptionTaskDef,
            publicLoadBalancer: true,
            desiredCount: 2,
            listenerPort: 80
        }).targetGroup.configureHealthCheck({
            path: '/health/status'
        });


        // PetListAdoptions service definitions-----------------------------------------------------------------------

        const taskRole_PetListAdoptions = new iam.Role(this, `ecs-taskRole-PayListAdoptions-${this.stackName}`, {
            roleName: `ecs-taskRole-PayListAdoptions-${this.stackName}`,
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
        });

        const petListAdoptionsTaskDef = new ecs.FargateTaskDefinition(this, "ecs-taskdef-petlist", {
            cpu: 1024,
            taskRole: taskRole_PetListAdoptions,
            memoryLimitMiB: 2048
        });

        petListAdoptionsTaskDef.addToExecutionRolePolicy(executionRolePolicy);

        petListAdoptionsTaskDef.taskRole?.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this, 'PayListAdoptions-AmazonECSTaskExecutionRolePolicy', 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'));
        petListAdoptionsTaskDef.taskRole?.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this, 'PayListAdoptions-AWSXrayWriteOnlyAccess', 'arn:aws:iam::aws:policy/AWSXrayWriteOnlyAccess'));
        petListAdoptionsTaskDef.taskRole?.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this, 'PayListAdoptions-AmazonRDSFullAccess', 'arn:aws:iam::aws:policy/AmazonRDSFullAccess'));
        petListAdoptionsTaskDef.taskRole?.addToPolicy(readSSMParamsPolicy);

        petListAdoptionsTaskDef.addContainer('petlistadoption', {
            image: ecs.ContainerImage.fromRegistry("awsimaya/petlistadoptions:latest"),
            memoryLimitMiB: 256,
            cpu: 256,
            logging
        }).addPortMappings({
            containerPort: 80,
            protocol: ecs.Protocol.TCP
        });

        petListAdoptionsTaskDef.addContainer('xraydaemon', {
            image: ecs.ContainerImage.fromRegistry('amazon/aws-xray-daemon'),
            memoryLimitMiB: 256,
            cpu: 256,
            logging
        }).addPortMappings({
            containerPort: 2000,
            protocol: ecs.Protocol.UDP
        });

        new ecs_patterns.ApplicationLoadBalancedFargateService(this, "PetListAdoption-service", {
            cluster: new ecs.Cluster(this, "PetListAdoption-cluster", {
                vpc: theVPC,
                containerInsights: true
            }),
            taskDefinition: petListAdoptionsTaskDef,
            publicLoadBalancer: true,
            desiredCount: 2,
            listenerPort: 80
        }).targetGroup.configureHealthCheck({
            path: '/health/status'
        });


        // PetSite service definitions-----------------------------------------------------------------------

        const taskRole_PetSite = new iam.Role(this, `ecs-taskRole-PetSite-${this.stackName}`, {
            roleName: `ecs-taskRole-PetSite-${this.stackName}`,
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
        });

        const PetSiteTaskDef = new ecs.FargateTaskDefinition(this, "ecs-taskdef-petsite", {
            taskRole: taskRole_PetSite,
            cpu: 1024,
            memoryLimitMiB: 2048
        });

        PetSiteTaskDef.addToExecutionRolePolicy(executionRolePolicy);

        PetSiteTaskDef.taskRole?.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this, 'PetSite-AmazonSQSFullAccess', 'arn:aws:iam::aws:policy/AmazonSQSFullAccess'));
        PetSiteTaskDef.taskRole?.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this, 'PetSite-AmazonSNSFullAccess', 'arn:aws:iam::aws:policy/AmazonSNSFullAccess'));
        PetSiteTaskDef.taskRole?.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this, 'PetSite-AmazonECSTaskExecutionRolePolicy', 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'));
        PetSiteTaskDef.taskRole?.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this, 'PetSite-AWSXrayWriteOnlyAccess', 'arn:aws:iam::aws:policy/AWSXrayWriteOnlyAccess'));
        PetSiteTaskDef.taskRole?.addToPolicy(readSSMParamsPolicy);

        PetSiteTaskDef.addContainer('PetSite', {
            image: ecs.ContainerImage.fromRegistry("awsimaya/petsite:latest"),
            memoryLimitMiB: 256,
            cpu: 256,
            logging
        }).addPortMappings({
            containerPort: 80,
            protocol: ecs.Protocol.TCP
        });

        PetSiteTaskDef.addContainer('xraydaemon', {
            image: ecs.ContainerImage.fromRegistry('amazon/aws-xray-daemon'),
            memoryLimitMiB: 256,
            cpu: 256,
            logging
        }).addPortMappings({
            containerPort: 2000,
            protocol: ecs.Protocol.UDP
        });

        new ecs_patterns.ApplicationLoadBalancedFargateService(this, "PetSite-service", {
            cluster: new ecs.Cluster(this, "PetSite-cluster", {
                vpc: theVPC,
                containerInsights: true
            }),
            taskDefinition: PetSiteTaskDef,
            publicLoadBalancer: true,
            desiredCount: 2,
            listenerPort: 80
        }).targetGroup.configureHealthCheck({
            path: '/health/status'
        });

        // PetSearch service definitions-----------------------------------------------------------------------

        const taskRole_PetSearch = new iam.Role(this, `ecs-taskRole-PetSearch-${this.stackName}`, {
            roleName: `ecs-taskRole-PetSearch-${this.stackName}`,
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
        });

        const PetSearchTaskDef = new ecs.FargateTaskDefinition(this, "ecs-taskdef-PetSearch", {
            taskRole: taskRole_PetSearch,
            cpu: 1024,
            memoryLimitMiB: 2048
        });

        PetSearchTaskDef.addToExecutionRolePolicy(executionRolePolicy);

        PetSearchTaskDef.taskRole?.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this, 'PetSearch-AmazonECSTaskExecutionRolePolicy', 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'));
        PetSearchTaskDef.taskRole?.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this, 'PetSearch-AWSXrayWriteOnlyAccess', 'arn:aws:iam::aws:policy/AWSXrayWriteOnlyAccess'));
        PetSearchTaskDef.taskRole?.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this, 'PetSearch-AmazonDynamoDBReadOnlyAccess', 'arn:aws:iam::aws:policy/AmazonDynamoDBReadOnlyAccess'));
        PetSearchTaskDef.taskRole?.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this, 'PetSearch-AmazonS3ReadOnlyAccess', 'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess'));

        PetSearchTaskDef.taskRole?.addToPolicy(readSSMParamsPolicy);

        PetSearchTaskDef.addContainer('PetSearch', {
            image: ecs.ContainerImage.fromRegistry("awsimaya/petsearch:latest"),
            memoryLimitMiB: 256,
            cpu: 256,
            logging
        }).addPortMappings({
            containerPort: 80,
            protocol: ecs.Protocol.TCP
        });

        PetSearchTaskDef.addContainer('xraydaemon', {
            image: ecs.ContainerImage.fromRegistry('amazon/aws-xray-daemon'),
            memoryLimitMiB: 256,
            cpu: 256,
            logging
        }).addPortMappings({
            containerPort: 2000,
            protocol: ecs.Protocol.UDP
        });

        new ecs_patterns.ApplicationLoadBalancedFargateService(this, "PetSearch-service", {
            cluster: new ecs.Cluster(this, "PetSearch-cluster", {
                vpc: theVPC,
                containerInsights: true
            }),
            taskDefinition: PetSearchTaskDef,
            publicLoadBalancer: true,
            desiredCount: 2,
            listenerPort: 80
        }).targetGroup.configureHealthCheck({
            path: '/health/status'
        });

        // Traffic Generator task definition. Only creates a task definition. Doesn't deploy a service or start a task. That's left to the user.
        const taskRole_trafficGenerator = new iam.Role(this, `ecs-taskRole_trafficGenerator-${this.stackName}`, {
            roleName: `ecs-taskRole_trafficGenerator-${this.stackName}`,
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
        });

        const trafficGeneratorTaskDef = new ecs.FargateTaskDefinition(this, "ecs-taskdef", {
            taskRole: taskRole_trafficGenerator,
            cpu: 256,
            memoryLimitMiB: 512
        });

        trafficGeneratorTaskDef.addToExecutionRolePolicy(executionRolePolicy);

        trafficGeneratorTaskDef.taskRole?.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this, 'AmazonECSTaskExecutionRolePolicy', 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'));
        trafficGeneratorTaskDef.taskRole?.addToPolicy(readSSMParamsPolicy);

        trafficGeneratorTaskDef.addContainer('trafficGenerator', {
            image: ecs.ContainerImage.fromRegistry("awsimaya/pet-trafficgenerator:latest"),
            memoryLimitMiB: 512,
            cpu: 256,
            logging
        }).addPortMappings({
            containerPort: 80,
            protocol: ecs.Protocol.TCP
        });

        //PetStatusUpdater Lambda Function and APIGW--------------------------------------

        var iamrole_PetStatusUpdater = new iam.Role(this, 'lambdaexecutionrole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromManagedPolicyArn(this, 'first', 'arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess'),
                iam.ManagedPolicy.fromManagedPolicyArn(this, 'second', 'arn:aws:iam::aws:policy/AWSLambdaFullAccess')],
            roleName: 'PetStatusUpdaterRole'
        });

        var lambda_petstatusupdater = new lambda.Function(this, 'lambdafn', {
            runtime: lambda.Runtime.NODEJS_12_X,    // execution environment
            code: lambda.Code.fromAsset('../resources/function.zip'),  // code loaded from "lambda" directory
            handler: 'index.handler',
            tracing: lambda.Tracing.ACTIVE,
            role: iamrole_PetStatusUpdater,
            description: 'Update Pet availability status',
            environment:
            {
                "TABLE_NAME": "petadoptions"
            }
        });

        //defines an API Gateway REST API resource backed by our "petstatusupdater" function.
        const apigateway = new apigw.LambdaRestApi(this, 'PetAdoptionStatusUpdater', {
            handler: lambda_petstatusupdater,
            proxy: true,
            endpointConfiguration: {
                types: [apigw.EndpointType.REGIONAL]
            }, deployOptions: {
                tracingEnabled: true,
                stageName: 'prod'
            }, options: { defaultMethodOptions: { methodResponses: [] } }
            //defaultIntegration: new apigw.Integration({ integrationHttpMethod: 'PUT', type: apigw.IntegrationType.AWS })
        });

        new cdk.CfnOutput(this, 'UpdateAdoptionStatusurl', { value: `${apigateway.url}` })
        new cdk.CfnOutput(this, 'QueueURL', { value: `${sqsQueue.queueUrl}` })
        new cdk.CfnOutput(this, 'SNSTopicARN', { value: `${topic_petadoption.topicArn}` })
        new cdk.CfnOutput(this, 'RDSServerName', { value: `${instance.dbInstanceEndpointAddress}` })

    }
}