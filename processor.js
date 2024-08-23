const { parentPort, workerData } = require('worker_threads');
const { getDeployerAddress, getDeployById, getMintAddress, validateRoyaltyPayment, validateMintData, isValidBitmapFormat, saveDeploy, saveMint, saveBitmap } = require('../index.js');
const winston = require('winston');

// Initialize the logger
const processorLogger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'processor.log' })
    ]
});

(async () => {
    try {
        const processedInscriptions = [];

        for (const { type, inscriptionId, content } of workerData.validInscriptions) {
            let result = null;

            if (type === 'deploy') {
                const deployData = JSON.parse(content);
                deployData.deployer_address = await getDeployerAddress(inscriptionId);
                deployData.block_height = workerData.blockHeight;
                deployData.timestamp = Date.now();
                deployData.source_id = deployData.id;

                result = { type: 'deploy', data: deployData };
            } else if (type === 'mint') {
                const mintId = content.split('/content/')[1].split('"')[0];
                const deployInscription = await getDeployById(mintId);

                if (deployInscription) {
                    const mintAddress = await getMintAddress(inscriptionId);
                    const transactionId = convertInscriptionIdToTxId(inscriptionId);

                    if (mintAddress) {
                        const isRoyaltyPaid = await validateRoyaltyPayment(deployInscription, mintAddress);
                        const isMintValid = await validateMintData(mintId, deployInscription, mintAddress, transactionId);

                        if (isRoyaltyPaid && isMintValid) {
                            result = {
                                type: 'mint',
                                data: {
                                    id: inscriptionId,
                                    deploy_id: deployInscription.id,
                                    source_id: mintId,
                                    mint_address: mintAddress,
                                    transaction_id: transactionId,
                                    block_height: workerData.blockHeight,
                                    timestamp: Date.now()
                                }
                            };
                        }
                    }
                }
            } else if (type === 'bitmap' && isValidBitmapFormat(content)) {
                const bitmapNumber = parseInt(content.split('.')[0], 10);
                if (!isNaN(bitmapNumber)) {
                    const address = await getDeployerAddress(inscriptionId);
                    if (address) {
                        result = {
                            type: 'bitmap',
                            data: {
                                inscription_id: inscriptionId,
                                bitmap_number: bitmapNumber,
                                content,
                                address,
                                timestamp: Date.now(),
                                block_height: workerData.blockHeight
                            }
                        };
                    }
                }
            }

            if (result) {
                processedInscriptions.push(result);
            }
        }

        parentPort.postMessage({ processedInscriptions });
    } catch (error) {
        processorLogger.error(`Error processing inscriptions: ${error.message}`);
        parentPort.postMessage({ error: error.message });
    }
})();
